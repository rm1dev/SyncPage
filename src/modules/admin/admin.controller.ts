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
import { ConfigService } from '@nestjs/config';
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
import {
  createExcelWorkbook,
  formatJalaliDateTime,
} from '../../common/excel.util';
// jdate.js extends standard classes
import 'jdate.js';

import { WebhookService } from '../form-engine/webhook.service';
import { KavenegarService } from '../form-engine/kavenegar.service';
import { IntegrationProfileService } from '../form-engine/integration-profile.service';
import { OutboxService } from '../sync/outbox.service';
import { CategoryService } from '../categories/category.service';

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
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
    private readonly categories: CategoryService,
  ) {}

  private groupByCategory<
    T extends { category?: { id: string; name: string } | null },
  >(items: T[]) {
    const groups = new Map<
      string,
      { id?: string; name: string; isDefault: boolean; items: T[] }
    >();
    for (const item of items) {
      const name = item.category?.name || 'بدون دسته بندی';
      const id = item.category?.id;
      const isDefault = !item.category;
      const group = groups.get(name) || {
        id,
        name,
        isDefault,
        items: [],
      };
      group.items.push(item);
      groups.set(name, group);
    }
    return [...groups.values()].sort((a, b) => {
      if (a.isDefault) return 1;
      if (b.isDefault) return -1;
      return a.name.localeCompare(b.name, 'fa');
    });
  }

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
  login(@Body('token') token: string, @Res() res: Response) {
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
    const [forms, nodes, formMetrics, masterUpdate, nodesVersion] =
      await Promise.all([
        this.forms.list(),
        this.nodes.list(),
        this.forms.getDashboardMetrics(),
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
      formMetrics,
      nodeCount: nodes.length,
      onlineCount: nodes.filter((n) => n.status === 'ONLINE').length,
    };
  }

  @Get('profiles')
  @UseGuards(AdminTokenGuard)
  @Render('admin/profiles')
  async profilesPage(
    @Query('flash') flash?: string,
    @Query('error') error?: string,
  ) {
    const profiles = await this.profiles.list();
    return {
      layout: 'main',
      title: 'مدیریت پروفایل‌ها',
      active: 'forms',
      flash,
      error,
      profiles,
    };
  }

  @Get('profiles/new')
  @UseGuards(AdminTokenGuard)
  @Render('admin/profile-edit')
  newProfile() {
    return {
      layout: 'main',
      title: 'افزودن پروفایل',
      active: 'forms',
      profile: {},
      startRow: 2,
    };
  }

  @Post('profiles')
  @UseGuards(AdminTokenGuard)
  async createProfile(
    @Body() body: Record<string, string>,
    @Res() res: Response,
  ) {
    try {
      const columnMapping = body.columnMapping
        ? JSON.parse(body.columnMapping)
        : null;
      await this.profiles.create({
        name: body.name,
        webhookUrl: body.webhookUrl || null,
        googleSheetUrl: body.googleSheetUrl || null,
        googleSheetMeta: columnMapping
          ? { startRow: Number(body.startRow) || 2, columns: columnMapping }
          : null,
      });
      return res.redirect(
        '/spadmin/profiles?flash=' + encodeURIComponent('پروفایل ساخته شد'),
      );
    } catch (err) {
      return res.status(400).render('admin/profile-edit', {
        layout: 'main',
        title: 'افزودن پروفایل',
        active: 'profiles',
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
      layout: 'main',
      title: 'ویرایش پروفایل',
      active: 'forms',
      profile,
      columnMappingJson: meta.columns
        ? JSON.stringify(meta.columns, null, 2)
        : '',
      startRow: meta.startRow || 2,
    };
  }

  @Post('profiles/:id')
  @UseGuards(AdminTokenGuard)
  async updateProfile(
    @Param('id') id: string,
    @Body() body: Record<string, string>,
    @Res() res: Response,
  ) {
    try {
      const columnMapping = body.columnMapping
        ? JSON.parse(body.columnMapping)
        : null;
      await this.profiles.update(id, {
        name: body.name,
        webhookUrl: body.webhookUrl || null,
        googleSheetUrl: body.googleSheetUrl || null,
        googleSheetMeta: columnMapping
          ? { startRow: Number(body.startRow) || 2, columns: columnMapping }
          : null,
      });
      return res.redirect(
        '/spadmin/profiles?flash=' +
          encodeURIComponent(
            'پروفایل به‌روز شد و تمامی فرم‌های متصل ویرایش شدند.',
          ),
      );
    } catch (err) {
      return res.status(400).render('admin/profile-edit', {
        layout: 'main',
        title: 'ویرایش پروفایل',
        active: 'forms',
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
      return res.redirect(
        '/spadmin/profiles?flash=' + encodeURIComponent('پروفایل حذف شد'),
      );
    } catch (err) {
      return res.redirect(
        '/spadmin/profiles?error=' +
          encodeURIComponent(
            err instanceof Error ? err.message : 'Delete failed',
          ),
      );
    }
  }

  @Get('forms')
  @UseGuards(AdminTokenGuard)
  @Render('admin/forms')
  async formsPage(
    @Query('q') q?: string,
    @Query('edit') editId?: string,
    @Query('new') newForm?: string,
    @Query('flash') flash?: string,
    @Query('error') error?: string,
  ) {
    const [rawForms, profiles, categories] = await Promise.all([
      this.forms.listWithSubmissionCounts(q),
      this.profiles.list(),
      this.categories.list(),
    ]);

    let form: any = {
      otpEnabled: false,
      otpField: 'mobile',
      otpTemplate: 'verify',
      sendUtmToWebhook: true,
      sendUtmToSheet: true,
    };
    let bodyJson = JSON.stringify(
      [
        { type: 'text', name: 'fullName', label: 'نام کامل', required: true },
        { type: 'text', name: 'mobile', label: 'شماره موبایل', required: true },
      ],
      null,
      2,
    );
    let columnMappingJson = JSON.stringify(
      { fullName: 'A', mobile: 'B' },
      null,
      2,
    );
    let startRow = 2;

    if (editId) {
      try {
        form = await this.forms.getById(editId);
        const meta: any = form.googleSheetMeta || {};
        bodyJson = JSON.stringify(form.body, null, 2);
        columnMappingJson = meta.columns
          ? JSON.stringify(meta.columns, null, 2)
          : '';
        startRow = meta.startRow || 2;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'فرم پیدا نشد';
        return {
          layout: 'main',
          title: 'مدیریت فرم‌ها',
          active: 'forms',
          forms: rawForms.map((item) => ({
            ...item,
            fieldCount: Array.isArray(item.body) ? item.body.length : 0,
            submissionCount: item._count.submissions,
            hasSubmissions: item._count.submissions > 0,
          })),
          formGroups: this.groupByCategory(
            rawForms.map((item) => ({
              ...item,
              fieldCount: Array.isArray(item.body) ? item.body.length : 0,
              submissionCount: item._count.submissions,
              hasSubmissions: item._count.submissions > 0,
            })),
          ),
          profiles,
          categories,
          form,
          bodyJson,
          columnMappingJson,
          startRow,
          error: message,
          editing: false,
          showEditor: false,
          flash,
          q,
        };
      }
    }

    return {
      layout: 'main',
      title: 'مدیریت فرم‌ها',
      active: 'forms',
      forms: rawForms.map((item) => ({
        ...item,
        fieldCount: Array.isArray(item.body) ? item.body.length : 0,
        submissionCount: item._count.submissions,
        hasSubmissions: item._count.submissions > 0,
      })),
      formGroups: this.groupByCategory(
        rawForms.map((item) => ({
          ...item,
          fieldCount: Array.isArray(item.body) ? item.body.length : 0,
          submissionCount: item._count.submissions,
          hasSubmissions: item._count.submissions > 0,
        })),
      ),
      profiles,
      categories,
      form,
      bodyJson,
      columnMappingJson,
      startRow,
      q,
      flash,
      error,
      editing: Boolean(editId),
      showEditor: Boolean(editId || newForm),
    };
  }

  @Get('forms/new')
  @UseGuards(AdminTokenGuard)
  newFormRedirect(@Res() res: Response) {
    return res.redirect('/spadmin/forms?new=1');
  }

  @Get('forms/:id')
  @UseGuards(AdminTokenGuard)
  editFormRedirect(@Param('id') id: string, @Res() res: Response) {
    return res.redirect(`/spadmin/forms?edit=${encodeURIComponent(id)}`);
  }

  @Post('forms/categories')
  @UseGuards(AdminTokenGuard)
  async createFormCategory(@Body('name') name: string, @Res() res: Response) {
    try {
      await this.categories.create(name);
      return res.redirect(
        '/spadmin/forms?flash=' + encodeURIComponent('دسته بندی ایجاد شد'),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Category creation failed';
      return res.redirect(
        `/spadmin/forms?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('forms/categories/:id')
  @UseGuards(AdminTokenGuard)
  async updateFormCategory(
    @Param('id') id: string,
    @Body('name') name: string,
    @Res() res: Response,
  ) {
    try {
      await this.categories.update(id, name);
      return res.redirect(
        '/spadmin/forms?flash=' + encodeURIComponent('دسته بندی ویرایش شد'),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'ویرایش دسته بندی با خطا مواجه شد';
      return res.redirect(
        `/spadmin/forms?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('forms/categories/:id/delete')
  @UseGuards(AdminTokenGuard)
  async deleteFormCategory(@Param('id') id: string, @Res() res: Response) {
    try {
      await this.categories.delete(id);
      return res.redirect(
        '/spadmin/forms?flash=' +
          encodeURIComponent(
            'دسته بندی حذف شد و آیتم‌های مربوطه به بدون دسته بندی منتقل شدند',
          ),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'حذف دسته بندی با خطا مواجه شد';
      return res.redirect(
        `/spadmin/forms?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('forms')
  @UseGuards(AdminTokenGuard)
  async createForm(@Body() body: Record<string, string>, @Res() res: Response) {
    try {
      const fields = JSON.parse(body.body || '[]');
      const columnMapping = body.columnMapping
        ? JSON.parse(body.columnMapping)
        : null;
      await this.forms.create({
        title: body.title,
        categoryId: body.categoryId || null,
        key: body.key,
        slug: body.slug,
        body: fields,
        webhookUrl: body.webhookUrl || null,
        googleSheetUrl: body.googleSheetUrl || null,
        googleSheetMeta: columnMapping
          ? { startRow: Number(body.startRow) || 2, columns: columnMapping }
          : undefined,
        otpEnabled: body.otpEnabled === 'true' || body.otpEnabled === 'on',
        otpField: body.otpField || 'mobile',
        otpTemplate: body.otpTemplate || 'verify',
        otpLength: body.otpLength ? parseInt(body.otpLength, 10) : 5,
        sendUtmToWebhook:
          body.sendUtmToWebhook === 'true' || body.sendUtmToWebhook === 'on',
        sendUtmToSheet:
          body.sendUtmToSheet === 'true' || body.sendUtmToSheet === 'on',
        profileId: body.profileId || null,
      });
      return res.redirect(
        '/spadmin/forms?flash=' + encodeURIComponent('فرم ذخیره شد'),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      return res
        .status(400)
        .redirect(`/spadmin/forms?new=1&error=${encodeURIComponent(message)}`);
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
      const columnMapping = body.columnMapping
        ? JSON.parse(body.columnMapping)
        : null;
      await this.forms.update(id, {
        title: body.title,
        categoryId: body.categoryId || null,
        slug: body.slug,
        body: fields,
        webhookUrl: body.webhookUrl || null,
        googleSheetUrl: body.googleSheetUrl || null,
        googleSheetMeta: columnMapping
          ? { startRow: Number(body.startRow) || 2, columns: columnMapping }
          : undefined,
        otpEnabled: body.otpEnabled === 'true' || body.otpEnabled === 'on',
        otpField: body.otpField || 'mobile',
        otpTemplate: body.otpTemplate || 'verify',
        otpLength: body.otpLength ? parseInt(body.otpLength, 10) : 5,
        sendUtmToWebhook:
          body.sendUtmToWebhook === 'true' || body.sendUtmToWebhook === 'on',
        sendUtmToSheet:
          body.sendUtmToSheet === 'true' || body.sendUtmToSheet === 'on',
        profileId: body.profileId || null,
      });
      return res.redirect(
        '/spadmin/forms?flash=' + encodeURIComponent('فرم به‌روز شد'),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      return res
        .status(400)
        .redirect(
          `/spadmin/forms?edit=${encodeURIComponent(id)}&error=${encodeURIComponent(message)}`,
        );
    }
  }

  @Get('landings')
  @UseGuards(AdminTokenGuard)
  @Render('admin/landings')
  async landingsPage(
    @Query('q') q?: string,
    @Query('previewId') previewId?: string,
    @Query('slug') slug?: string,
    @Query('categoryId') categoryId?: string,
    @Query('checksum') checksum?: string,
    @Query('previewUrl') previewUrl?: string,
    @Query('flash') flash?: string,
    @Query('error') error?: string,
    @Query('operation') operation?: string,
  ) {
    const [rawLandings, pendingSyncCount, categories] = await Promise.all([
      this.deployment.listLandings(q),
      this.outbox.getMasterPendingSyncCount(),
      this.categories.list(),
    ]);

    const landings = rawLandings.map((l) => {
      const d = new Date(l.updatedAt);
      const j = (d as any).jalali;
      const jdateStr = j
        ? `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.date).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        : d.toLocaleString('fa-IR');

      let landingUrl = `/${l.slug}/`;
      const domain = this.config.get<string>('domain');
      if (domain) {
        landingUrl = `//${domain}/${l.slug}/`;
      }

      return {
        ...l,
        checksumShort: l.checksum ? l.checksum.slice(0, 12) + '…' : '—',
        updatedAtFa: jdateStr,
        isActive: l.status === 'ACTIVE',
        landingUrl,
      };
    });

    return {
      layout: 'main',
      title: 'مدیریت لندینگ‌ها',
      active: 'landings',
      landings,
      landingGroups: this.groupByCategory(landings),
      pendingSyncCount,
      previewId,
      slug,
      categoryId,
      categories,
      q,
      checksum,
      previewUrl,
      flash,
      error,
      operation,
    };
  }

  @Get('api/sync-operations/:id')
  @UseGuards(AdminTokenGuard)
  getSyncOperation(@Param('id') id: string) {
    return this.deployment.getSyncOperationStatus(id);
  }

  @Post('landings/categories')
  @UseGuards(AdminTokenGuard)
  async createLandingCategory(
    @Body('name') name: string,
    @Res() res: Response,
  ) {
    try {
      await this.categories.create(name);
      return res.redirect(
        '/spadmin/landings?flash=' + encodeURIComponent('دسته بندی ایجاد شد'),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Category creation failed';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('landings/categories/:id')
  @UseGuards(AdminTokenGuard)
  async updateLandingCategory(
    @Param('id') id: string,
    @Body('name') name: string,
    @Res() res: Response,
  ) {
    try {
      await this.categories.update(id, name);
      return res.redirect(
        '/spadmin/landings?flash=' + encodeURIComponent('دسته بندی ویرایش شد'),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'ویرایش دسته بندی با خطا مواجه شد';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('landings/categories/:id/delete')
  @UseGuards(AdminTokenGuard)
  async deleteLandingCategory(@Param('id') id: string, @Res() res: Response) {
    try {
      await this.categories.delete(id);
      return res.redirect(
        '/spadmin/landings?flash=' +
          encodeURIComponent(
            'دسته بندی حذف شد و لندینگ‌های مربوطه به بدون دسته بندی منتقل شدند',
          ),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'حذف دسته بندی با خطا مواجه شد';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('landings/upload')
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
  async uploadLanding(
    @UploadedFile() file: Express.Multer.File,
    @Body('slug') slug: string,
    @Body('categoryId') categoryId: string,
    @Res() res: Response,
  ) {
    try {
      if (!file) throw new BadRequestException('فایل ZIP الزامی است');
      const result = await this.deployment.uploadPreview(slug, file.path);
      const q = new URLSearchParams({
        previewId: result.previewId,
        slug: result.slug,
        categoryId: categoryId || '',
        checksum: result.checksum,
        previewUrl: result.previewUrl,
      });
      return res.redirect(`/spadmin/landings?${q.toString()}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'بارگذاری ناموفق بود';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('landings/confirm')
  @UseGuards(AdminTokenGuard)
  async confirmLanding(
    @Body() body: { previewId: string; slug: string; categoryId?: string },
    @Res() res: Response,
  ) {
    try {
      const landing = await this.deployment.confirm(
        body.previewId,
        body.slug,
        body.categoryId,
      );
      const operation = await this.deployment.trackSyncOperation([body.slug]);
      return res.redirect(
        `/spadmin/landings?operation=${encodeURIComponent(operation.id)}`,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'استقرار با خطا مواجه شد';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('landings/sync-all')
  @UseGuards(AdminTokenGuard)
  async syncAllLandingsPage(@Res() res: Response) {
    try {
      const result = await this.deployment.syncAll();
      return res.redirect(
        `/spadmin/landings?operation=${encodeURIComponent(result.operationId)}`,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'همگام‌سازی ناموفق بود';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('landings/sync/:slug')
  @UseGuards(AdminTokenGuard)
  async syncSingleLandingPage(
    @Param('slug') slug: string,
    @Res() res: Response,
  ) {
    try {
      const operation = await this.deployment.syncSingle(slug);
      return res.redirect(
        `/spadmin/landings?operation=${encodeURIComponent(operation.id)}`,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'همگام‌سازی ناموفق بود';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('landings/:slug/category')
  @UseGuards(AdminTokenGuard)
  async reassignLandingCategory(
    @Param('slug') slug: string,
    @Body('categoryId') categoryId: string,
    @Res() res: Response,
  ) {
    try {
      await this.deployment.reassignCategory(slug, categoryId || null);
      return res.redirect(
        '/spadmin/landings?flash=' +
          encodeURIComponent('دسته بندی لندینگ به روز شد'),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Category update failed';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('landings/:slug')
  @UseGuards(AdminTokenGuard)
  async updateLanding(
    @Param('slug') slug: string,
    @Body('categoryId') categoryId: string,
    @Res() res: Response,
  ) {
    try {
      await this.deployment.updateLandingCategory(slug, categoryId || null);
      return res.redirect(
        '/spadmin/landings?flash=' +
          encodeURIComponent('دسته بندی لندینگ به روز شد'),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'ویرایش لندینگ ناموفق بود';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('landings/delete/:slug')
  @UseGuards(AdminTokenGuard)
  async deleteLanding(@Param('slug') slug: string, @Res() res: Response) {
    try {
      await this.deployment.deleteLanding(slug);
      return res.redirect(
        `/spadmin/landings?flash=${encodeURIComponent(`لندینگ ${slug} حذف شد و دستور حذف به نودها ارسال گردید`)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'حذف ناموفق بود';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Get('deploy')
  @UseGuards(AdminTokenGuard)
  deployPageRedirect(@Res() res: Response) {
    return res.redirect('/spadmin/landings');
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
    @Body('categoryId') categoryId: string,
    @Res() res: Response,
  ) {
    try {
      if (!file) throw new BadRequestException('ZIP required');
      const result = await this.deployment.uploadPreview(slug, file.path);
      const q = new URLSearchParams({
        previewId: result.previewId,
        slug: result.slug,
        categoryId: categoryId || '',
        checksum: result.checksum,
        previewUrl: result.previewUrl,
      });
      return res.redirect(`/spadmin/landings?${q.toString()}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('deploy/confirm')
  @UseGuards(AdminTokenGuard)
  async confirm(
    @Body() body: { previewId: string; slug: string; categoryId?: string },
    @Res() res: Response,
  ) {
    try {
      await this.deployment.confirm(body.previewId, body.slug, body.categoryId);
      return res.redirect(
        `/spadmin/landings?flash=${encodeURIComponent('لندینگ مستقر و در صف همگام‌سازی قرار گرفت')}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Confirm failed';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('deploy/sync-all')
  @UseGuards(AdminTokenGuard)
  async syncAllLandings(@Res() res: Response) {
    try {
      const result = await this.deployment.syncAll();
      return res.redirect(
        `/spadmin/landings?flash=${encodeURIComponent(`همگام‌سازی ${result.synced} لندینگ آغاز شد`)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('deploy/sync/:slug')
  @UseGuards(AdminTokenGuard)
  async syncSingleLanding(@Param('slug') slug: string, @Res() res: Response) {
    try {
      await this.deployment.syncSingle(slug);
      return res.redirect(
        `/spadmin/landings?flash=${encodeURIComponent(`همگام‌سازی مجدد ${slug} آغاز شد`)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      return res.redirect(
        `/spadmin/landings?error=${encodeURIComponent(message)}`,
      );
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
    return res.redirect(
      '/spadmin/settings?flash=' +
        encodeURIComponent('تنظیمات کاوه‌نگار ذخیره شد'),
    );
  }

  @Get('submissions')
  @UseGuards(AdminTokenGuard)
  @Render('admin/submissions')
  async submissionsPage(
    @Query('formId') formId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('otpFilter') otpFilter?: string,
    @Query('utmFilter') utmFilter?: string,
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
      utmFilter,
    );

    const submissions = rawSubmissions.map((s) => {
      const d = new Date(s.createdAt);
      const j = (d as any).jalali;
      const jdateStr = j
        ? `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.date).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        : d.toLocaleString('fa-IR');

      const payloadObj = s.payload as Record<string, unknown>;
      const utms: { key: string; value: string }[] = [];

      // استخراج UTM ها برای نمایش
      if (payloadObj) {
        for (const [key, val] of Object.entries(payloadObj)) {
          if (key.startsWith('utm_')) {
            utms.push({ key: key.replace('utm_', ''), value: String(val) });
          }
        }
      }

      return {
        id: s.id,
        formTitle: s.form?.title || '—',
        jalaliDate: jdateStr,
        nodeTitle: s.edgeNode ? s.edgeNode.title : 'سرور Master (لوکال)',
        payloadStr: JSON.stringify(s.payload, null, 2),
        otpStatus: s.otpStatus,
        isVerified: s.otpStatus === 'VERIFIED',
        isUnverified: s.otpStatus === 'UNVERIFIED',
        utms,
        utmStr: utms.length > 0 ? true : false,
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
      utmFilter,
      submissions,
    };
  }

  @Get('submissions/export/excel')
  @UseGuards(AdminTokenGuard)
  async exportSubmissionsExcel(
    @Query('formId') formId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('otpFilter') otpFilter?: string,
    @Query('utmFilter') utmFilter?: string,
    @Res() res?: Response,
  ) {
    let fromDate: Date | undefined;
    let toDate: Date | undefined;

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
      formId || undefined,
      fromDate,
      toDate,
      otpFilter,
      utmFilter,
    );

    // استخراج تمام کلیدهای منحصر به فرد payload برای ستون‌های داینامیک
    const payloadKeys = new Set<string>();
    const utmKeys = new Set<string>();

    rawSubmissions.forEach((s) => {
      const payloadObj = (s.payload || {}) as Record<string, unknown>;
      Object.keys(payloadObj).forEach((k) => {
        if (k.startsWith('utm_')) {
          utmKeys.add(k);
        } else {
          payloadKeys.add(k);
        }
      });
    });

    const columns = [
      { header: 'شناسه لید', key: 'id', width: 36 },
      { header: 'عنوان فرم', key: 'formTitle', width: 22 },
      { header: 'کلید فرم', key: 'formKey', width: 18 },
      { header: 'نود مبدا', key: 'nodeTitle', width: 20 },
      { header: 'وضعیت OTP', key: 'otpStatus', width: 16 },
      { header: 'تاریخ ثبت (جلالی)', key: 'jalaliDate', width: 22 },
      { header: 'تاریخ میلادی', key: 'createdAt', width: 22 },
      ...Array.from(payloadKeys).map((key) => ({
        header: key,
        key: `payload_${key}`,
        width: 20,
      })),
      ...Array.from(utmKeys).map((key) => ({
        header: `UTM: ${key.replace('utm_', '')}`,
        key: `utm_${key}`,
        width: 18,
      })),
    ];

    const rows = rawSubmissions.map((s) => {
      const payloadObj = (s.payload || {}) as Record<string, unknown>;
      let otpLabel = 'بدون OTP';
      if (s.otpStatus === 'VERIFIED') otpLabel = 'تایید شده';
      else if (s.otpStatus === 'UNVERIFIED') otpLabel = 'تایید نشده';

      const rowData: Record<string, any> = {
        id: s.id,
        formTitle: s.form?.title || '—',
        formKey: (s.form as any)?.key || '—',
        nodeTitle: s.edgeNode ? s.edgeNode.title : 'سرور Master (لوکال)',
        otpStatus: otpLabel,
        jalaliDate: formatJalaliDateTime(s.createdAt),
        createdAt: new Date(s.createdAt)
          .toISOString()
          .replace('T', ' ')
          .substring(0, 19),
      };

      payloadKeys.forEach((key) => {
        const val = payloadObj[key];
        rowData[`payload_${key}`] =
          val !== undefined && val !== null
            ? typeof val === 'object'
              ? JSON.stringify(val)
              : String(val)
            : '';
      });

      utmKeys.forEach((key) => {
        const val = payloadObj[key];
        rowData[`utm_${key}`] =
          val !== undefined && val !== null ? String(val) : '';
      });

      return rowData;
    });

    const buffer = await createExcelWorkbook('Submissions', columns, rows);
    const fileName = `leads_export_${Date.now()}.xlsx`;

    res?.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res?.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res?.send(buffer);
  }

  @Get('developers/webhook-history')
  @UseGuards(AdminTokenGuard)
  @Render('admin/webhook-history')
  webhookHistoryPage() {
    return {
      layout: 'main',
      title: 'فراخوانی‌های وب‌هوک',
      active: 'webhook-history',
    };
  }

  @Get('api/webhook-invocations')
  @UseGuards(AdminTokenGuard)
  async webhookInvocations(
    @Query('page') pageValue?: string,
    @Query('pageSize') pageSizeValue?: string,
  ) {
    const page = Math.max(1, Number.parseInt(pageValue || '1', 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(10, Number.parseInt(pageSizeValue || '20', 10) || 20),
    );
    const result = await this.forms.listWebhookInvocations(page, pageSize);

    return {
      ...result,
      items: result.items.map((item) => ({
        id: item.id,
        attempt: item.attempt,
        requestUrl: item.requestUrl,
        success: item.success,
        responseStatus: item.responseStatus,
        responseBody: item.responseBody,
        responseHeaders: item.responseHeaders,
        error: item.error,
        durationMs: item.durationMs,
        createdAt: item.createdAt.toISOString(),
        formTitle: item.submission.form.title,
        formKey: item.submission.form.key,
        submissionId: item.submissionId,
        nodeTitle: item.submission.edgeNode?.title || 'سرور Master (لوکال)',
      })),
    };
  }

  @Get('developers/webhook-history/export/excel')
  @UseGuards(AdminTokenGuard)
  async exportWebhookInvocationsExcel(@Res() res: Response) {
    const result = await this.forms.listWebhookInvocations();

    const columns = [
      { header: 'شناسه فراخوانی', key: 'id', width: 36 },
      { header: 'عنوان فرم', key: 'formTitle', width: 22 },
      { header: 'کلید فرم', key: 'formKey', width: 18 },
      { header: 'شناسه لید (Submission)', key: 'submissionId', width: 36 },
      { header: 'نود مبدا', key: 'nodeTitle', width: 20 },
      { header: 'تلاش', key: 'attempt', width: 10 },
      { header: 'آدرس وب‌هوک (URL)', key: 'requestUrl', width: 35 },
      { header: 'نتیجه', key: 'status', width: 12 },
      { header: 'کد وضعیت HTTP', key: 'responseStatus', width: 16 },
      { header: 'زمان پاسخ (ms)', key: 'durationMs', width: 16 },
      { header: 'متن خطا', key: 'error', width: 30 },
      { header: 'پاسخ سرور (Response Body)', key: 'responseBody', width: 35 },
      { header: 'هدرهای پاسخ (Headers)', key: 'responseHeaders', width: 25 },
      { header: 'تاریخ فراخوانی (جلالی)', key: 'jalaliDate', width: 22 },
      { header: 'تاریخ میلادی', key: 'createdAt', width: 22 },
    ];

    const rows = result.items.map((item) => ({
      id: item.id,
      formTitle: item.submission.form.title,
      formKey: item.submission.form.key,
      submissionId: item.submissionId,
      nodeTitle: item.submission.edgeNode?.title || 'سرور Master (لوکال)',
      attempt: item.attempt,
      requestUrl: item.requestUrl,
      status: item.success ? 'موفق' : 'ناموفق',
      responseStatus: item.responseStatus ? String(item.responseStatus) : '—',
      durationMs:
        item.durationMs !== null && item.durationMs !== undefined
          ? item.durationMs
          : '—',
      error: item.error || '—',
      responseBody: item.responseBody || '—',
      responseHeaders: item.responseHeaders
        ? JSON.stringify(item.responseHeaders)
        : '—',
      jalaliDate: formatJalaliDateTime(item.createdAt),
      createdAt: new Date(item.createdAt)
        .toISOString()
        .replace('T', ' ')
        .substring(0, 19),
    }));

    const buffer = await createExcelWorkbook(
      'WebhookInvocations',
      columns,
      rows,
    );
    const fileName = `webhook_invocations_${Date.now()}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(buffer);
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

  @Get('failed-webhooks/export/excel')
  @UseGuards(AdminTokenGuard)
  async exportFailedWebhooksExcel(@Res() res: Response) {
    const raw = await this.forms.listFailedWebhooks();

    // استخراج تمام کلیدهای منحصر به فرد payload برای ستون‌ها
    const payloadKeys = new Set<string>();
    raw.forEach((s) => {
      const payloadObj = (s.payload || {}) as Record<string, unknown>;
      Object.keys(payloadObj).forEach((k) => payloadKeys.add(k));
    });

    const columns = [
      { header: 'شناسه لید', key: 'id', width: 36 },
      { header: 'عنوان فرم', key: 'formTitle', width: 22 },
      { header: 'کلید فرم', key: 'formKey', width: 18 },
      { header: 'نود مبدا', key: 'nodeTitle', width: 20 },
      { header: 'تعداد تلاش', key: 'attempts', width: 14 },
      { header: 'آخرین متن خطا', key: 'lastError', width: 35 },
      { header: 'تاریخ ثبت لید (جلالی)', key: 'jalaliDate', width: 22 },
      { header: 'آخرین بروزرسانی (جلالی)', key: 'updatedAtFa', width: 22 },
      { header: 'تاریخ میلادی', key: 'createdAt', width: 22 },
      ...Array.from(payloadKeys).map((key) => ({
        header: key,
        key: `payload_${key}`,
        width: 20,
      })),
    ];

    const rows = raw.map((s) => {
      const payloadObj = (s.payload || {}) as Record<string, unknown>;
      const rowData: Record<string, any> = {
        id: s.id,
        formTitle: s.form?.title || '—',
        formKey: s.form?.key || '—',
        nodeTitle: s.edgeNode ? s.edgeNode.title : 'سرور Master (لوکال)',
        attempts: s.webhookAttempts,
        lastError: s.webhookLastError || '—',
        jalaliDate: formatJalaliDateTime(s.createdAt),
        updatedAtFa: formatJalaliDateTime(s.updatedAt),
        createdAt: new Date(s.createdAt)
          .toISOString()
          .replace('T', ' ')
          .substring(0, 19),
      };

      payloadKeys.forEach((key) => {
        const val = payloadObj[key];
        rowData[`payload_${key}`] =
          val !== undefined && val !== null
            ? typeof val === 'object'
              ? JSON.stringify(val)
              : String(val)
            : '';
      });

      return rowData;
    });

    const buffer = await createExcelWorkbook('FailedWebhooks', columns, rows);
    const fileName = `failed_webhooks_${Date.now()}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(buffer);
  }

  @Post('failed-webhooks/:id/retry')
  @UseGuards(AdminTokenGuard)
  async retryWebhook(@Param('id') id: string, @Res() res: Response) {
    try {
      await this.webhook.retryFailedWebhook(id);
      return res.redirect(
        '/spadmin/failed-webhooks?flash=' +
          encodeURIComponent('وب‌هوک با موفقیت ارسال شد'),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return res.redirect(
        '/spadmin/failed-webhooks?error=' +
          encodeURIComponent(`ارسال مجدد ناموفق بود: ${message}`),
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

    // پروب کردن سلامتی برای بدست آوردن تعداد سابمیشن‌های منتظر (pending) در Edge
    const probes = await Promise.all(
      nodes.map((n) => this.nodes.probeHealth(n.id)),
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
          activeDownload: probe?.activeDownload || null,
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
  async createNode(@Body() body: Record<string, string>, @Res() res: Response) {
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
      this.nodes.probeHealth(id).catch(() => null),
    ]);
    const latest = masterUpdate.latestVersion;
    const localVersion = probed?.version || null;
    const versionOutdated =
      !!latest && !!localVersion && isOutdated(localVersion, latest);

    // مقایسه نسخه‌ها برای بررسی همگام بودن
    const edgeLandings = (probed as any)?.edgeLandings || [];
    const masterLandings = await this.deployment.listLandings();

    const landingStatus = masterLandings.map((ml) => {
      const el = edgeLandings.find((e: any) => e.slug === ml.slug);
      return {
        slug: ml.slug,
        masterVersion: ml.version,
        edgeVersion: el ? el.version : 'ندارد',
        isSynced:
          el && el.version === ml.version && el.checksum === ml.checksum,
      };
    });

    return {
      layout: 'main',
      title: node.title,
      active: 'nodes',
      flash,
      error,
      appVersion: masterUpdate.localVersion,
      landingStatus,
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

  @Get('api/nodes/:id/live-status')
  @UseGuards(AdminTokenGuard)
  async getLiveNodeStatus(@Param('id') id: string) {
    const node = await this.nodes.getById(id);
    const probed = await this.nodes.probeHealth(id).catch(() => null);
    const masterLandings = await this.deployment.listLandings();
    const edgeLandings = (probed as any)?.edgeLandings || [];

    const landingStatus = masterLandings.map((ml) => {
      const el = edgeLandings.find((e: any) => e.slug === ml.slug);
      return {
        slug: ml.slug,
        masterVersion: ml.version,
        edgeVersion: el ? el.version : null,
        isSynced:
          el && el.version === ml.version && el.checksum === ml.checksum,
      };
    });

    return {
      ok: !!probed?.ok,
      node: {
        id: node.id,
        title: node.title,
        status: node.status,
        rabbitStatus: node.rabbitStatus,
      },
      stats: {
        pendingSubmissions: (probed as any)?.pendingSubmissions || 0,
        activeDownload: (probed as any)?.activeDownload || null,
        downloadHistory: (probed as any)?.downloadHistory || [],
      },
      landingStatus,
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
          const m = r.message;
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
