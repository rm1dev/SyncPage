import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FileService } from './file.service';
import { NodesService } from '../nodes/nodes.service';
import { CategoryService } from '../categories/category.service';

@Injectable()
export class DeploymentService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FileService,
    private readonly config: ConfigService,
    private readonly nodesService: NodesService,
    private readonly categories: CategoryService,
  ) {}

  onModuleInit() {
    this.files.ensureDirs();
  }

  listLandings(q?: string) {
    const query = q?.trim();
    const where: Prisma.LandingWhereInput | undefined = query
      ? {
          OR: [
            { slug: { contains: query, mode: 'insensitive' } },
            { category: { name: { contains: query, mode: 'insensitive' } } },
          ],
        }
      : undefined;

    return this.prisma.landing.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: { category: true },
    });
  }

  async uploadPreview(slug: string, zipPath: string) {
    if (!slug || !/^[a-z0-9-_]+$/i.test(slug)) {
      throw new BadRequestException('Invalid slug');
    }
    if (!existsSync(zipPath)) {
      throw new BadRequestException('Uploaded ZIP not found');
    }

    const previewId = randomUUID();
    const previewDir = join(this.files.tempRoot, 'preview', previewId);
    this.files.extractZip(zipPath, previewDir);

    if (!existsSync(join(previewDir, 'index.html'))) {
      throw new BadRequestException(
        'داخل ZIP باید index.html باشد (در ریشه یا داخل یک پوشه)',
      );
    }

    // برای پیش‌نمایش داخل iframe — مسیر نسبی assetها درست resolve بشه
    this.files.ensureHtmlBaseHref(previewDir, `/preview/${previewId}/`);

    const checksum = this.files.checksumFile(zipPath);

    // ZIP اصلی رو نگه می‌داریم برای confirm و sync
    const storedZip = join(this.files.tempRoot, 'packages', `${previewId}.zip`);
    const { copyFileSync } = await import('fs');
    copyFileSync(zipPath, storedZip);

    const previewPath = `/preview/${previewId}/`;

    return {
      previewId,
      slug,
      checksum,
      previewUrl: previewPath,
      storedZip,
    };
  }

  async confirm(previewId: string, slug: string, categoryId?: string | null) {
    const category = await this.categories.requireById(categoryId);
    const previewDir = join(this.files.tempRoot, 'preview', previewId);
    const storedZip = join(this.files.tempRoot, 'packages', `${previewId}.zip`);

    if (!existsSync(previewDir) || !existsSync(storedZip)) {
      throw new NotFoundException('پیش‌نمایش پیدا نشد یا منقضی شده');
    }

    const checksum = this.files.checksumFile(storedZip);

    // از ZIP تمیز استخراج می‌کنیم (نه از preview که <base href> برای iframe داره)
    const confirmDir = join(
      this.files.tempRoot,
      'preview',
      `confirm-${previewId}`,
    );
    this.files.extractZip(storedZip, confirmDir);
    if (!existsSync(join(confirmDir, 'index.html'))) {
      throw new BadRequestException(
        'داخل ZIP باید index.html باشد (در ریشه یا داخل یک پوشه)',
      );
    }

    this.files.replaceLandingAtomic(slug, confirmDir);
    this.files.cleanPreview(`confirm-${previewId}`);

    const existing = await this.prisma.landing.findUnique({ where: { slug } });
    const version = existing ? existing.version + 1 : 1;

    this.files.checksumDirMarker(slug, version, checksum);

    // پکیج تاییدشده را با نام content-addressed نگه می‌داریم تا eventهای
    // در صف همیشه دقیقا همان بایت‌هایی را دانلود کنند که checksum آن‌هاست.
    const { copyFileSync, unlinkSync } = await import('fs');
    const packageFile = `${slug}-v${version}-${checksum}.zip`;
    const finalZip = join(this.files.tempRoot, 'packages', packageFile);
    copyFileSync(storedZip, finalZip);

    const masterInternalUrl =
      this.config.get<string>('masterInternalUrl') || 'http://localhost:3000';
    const masterUrl = masterInternalUrl.endsWith('/')
      ? masterInternalUrl.slice(0, -1)
      : masterInternalUrl;
    const publicBaseUrl = this.config.get<string>('publicBaseUrl');
    let publicBase = '';
    if (publicBaseUrl) {
      publicBase = publicBaseUrl.endsWith('/')
        ? publicBaseUrl.slice(0, -1)
        : publicBaseUrl;
    }
    const packagePath = `/api/internal/landings/${slug}/package/${packageFile}`;
    const idempotencyKey = `landing:${slug}:v${version}:${checksum}`;

    const landing = await this.prisma.$transaction(async (tx) => {
      const row = await tx.landing.upsert({
        where: { slug },
        create: {
          slug,
          version,
          checksum,
          categoryId: category?.id || null,
          status: 'ACTIVE',
        },
        update: {
          version,
          checksum,
          categoryId: category?.id || null,
          status: 'ACTIVE',
        },
      });

      // Outbox داخل همون تراکنش — Transactional Outbox
      await tx.outboxEvent.create({
        data: {
          eventType: 'landing.sync',
          idempotencyKey,
          payload: {
            idempotencyKey,
            slug,
            version,
            checksum,
            category: category?.name || null,
            // Edge اول از IP داخلی Master دانلود می‌کنه؛ اگه نشد public رو هم امتحان می‌کنه
            downloadUrl: `${masterUrl}${packagePath}`,
            ...(publicBase
              ? { downloadUrlFallback: `${publicBase}${packagePath}` }
              : {}),
          },
        },
      });

      return row;
    });

    // تمیزکاری preview
    this.files.cleanPreview(previewId);
    try {
      unlinkSync(storedZip);
    } catch {
      /* ignore */
    }

    console.log(`Landing confirmed: ${slug} v${version}`);
    return landing;
  }

  async updateLandingCategory(slug: string, categoryId?: string | null) {
    const category = await this.categories.requireById(categoryId);
    const existing = await this.prisma.landing.findUnique({ where: { slug } });
    if (!existing) throw new NotFoundException('لندینگ یافت نشد');

    return this.prisma.landing.update({
      where: { id: existing.id },
      data: { categoryId: category?.id || null },
    });
  }

  async reassignCategory(slug: string, categoryId?: string | null) {
    const category = await this.categories.requireById(categoryId);
    return this.prisma.landing.update({
      where: { slug },
      data: { categoryId: category?.id || null },
    });
  }

  async syncSingle(slug: string) {
    const operation = await this.createSyncOperation([slug]);
    await this.syncSingleForOperation(slug, operation.id);
    return operation;
  }

  private async syncSingleForOperation(slug: string, operationId: string) {
    const landing = await this.prisma.landing.findUnique({
      where: { slug },
    });
    if (!landing) throw new NotFoundException('لندینگ یافت نشد');

    const version = landing.version + 1;
    const packageInfo = this.files.createImmutableLandingPackage(slug, version);
    const checksum = packageInfo.checksum;
    const masterUrl = (
      this.config.get<string>('masterInternalUrl') || 'http://localhost:3000'
    ).replace(/\/$/, '');
    const publicBase = (this.config.get<string>('publicBaseUrl') || '').replace(
      /\/$/,
      '',
    );
    const packagePath = `/api/internal/landings/${slug}/package/${packageInfo.fileName}`;
    const nodes = await this.prisma.edgeNode.findMany();

    await this.prisma.$transaction(async (tx) => {
      await tx.landing.update({
        where: { slug },
        data: { version, checksum },
      });

      for (const node of nodes) {
        const idempotencyKey = `landing:${slug}:v${version}:${checksum}:node:${node.id}`;
        await tx.outboxEvent.create({
          data: {
            eventType: 'landing.sync',
            idempotencyKey,
            payload: {
              idempotencyKey,
              operationId,
              slug,
              version,
              checksum,
              targetQueue: node.queueName,
              downloadUrl: `${masterUrl}${packagePath}`,
              ...(publicBase
                ? { downloadUrlFallback: `${publicBase}${packagePath}` }
                : {}),
            },
          },
        });
      }
    });

    this.files.checksumDirMarker(slug, version, checksum);
  }

  async syncAll() {
    const landings = (await this.listLandings()).filter(
      (landing) => landing.status === 'ACTIVE',
    );
    const operation = await this.createSyncOperation(
      landings.map((l) => l.slug),
    );
    for (const landing of landings) {
      await this.syncSingleForOperation(landing.slug, operation.id);
    }
    return { synced: landings.length, operationId: operation.id };
  }

  async trackSyncOperation(landingSlugs: string[]) {
    return this.createSyncOperation(landingSlugs);
  }

  private async createSyncOperation(landingSlugs: string[]) {
    const nodes = await this.prisma.edgeNode.findMany({ select: { id: true } });
    return this.prisma.syncOperation.create({
      data: {
        landingSlugs,
        status: nodes.length ? 'RUNNING' : 'COMPLETED',
        nodes: { create: nodes.map((node) => ({ nodeId: node.id })) },
      },
    });
  }

  async getSyncOperationStatus(operationId: string) {
    const operation = await this.prisma.syncOperation.findUnique({
      where: { id: operationId },
      include: {
        nodes: { include: { node: true }, orderBy: { node: { title: 'asc' } } },
      },
    });
    if (!operation) throw new NotFoundException('عملیات همگام‌سازی پیدا نشد');

    const expected = await this.prisma.landing.findMany({
      where: { slug: { in: operation.landingSlugs as string[] } },
      select: { slug: true, version: true, checksum: true },
    });
    const nodes = await Promise.all(
      operation.nodes.map(async (entry) => {
        const probe = await this.nodesService.probeHealth(entry.nodeId);
        const active = probe?.activeDownload;
        const isComplete =
          !!probe?.ok &&
          expected.every((landing) =>
            (probe.edgeLandings || []).some(
              (edge: any) =>
                edge.slug === landing.slug &&
                edge.version === landing.version &&
                edge.checksum === landing.checksum,
            ),
          );
        const status = isComplete
          ? 'COMPLETED'
          : !probe?.ok
            ? 'UNREACHABLE'
            : active
              ? 'DEPLOYING'
              : entry.status;
        const lastError = !probe?.ok
          ? 'نود از طریق health در دسترس نیست'
          : null;
        if (status !== entry.status || lastError !== entry.lastError) {
          await this.prisma.syncOperationNode.update({
            where: {
              operationId_nodeId: { operationId, nodeId: entry.nodeId },
            },
            data: {
              status,
              lastError,
              ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}),
            },
          });
        }
        return {
          id: entry.nodeId,
          title: entry.node.title,
          status,
          lastError,
          activeDownload: active || null,
          rabbitStatus: probe?.rabbitmq?.ok ? 'ONLINE' : 'OFFLINE',
        };
      }),
    );
    const completed = nodes.filter(
      (node) => node.status === 'COMPLETED',
    ).length;
    const failed = nodes.filter(
      (node) => node.status === 'FAILED' || node.status === 'UNREACHABLE',
    ).length;
    const status =
      completed === nodes.length
        ? 'COMPLETED'
        : completed || failed
          ? 'PARTIAL'
          : 'RUNNING';
    if (status !== operation.status)
      await this.prisma.syncOperation.update({
        where: { id: operationId },
        data: { status },
      });
    return {
      id: operationId,
      status,
      landings: expected,
      nodes,
      createdAt: operation.createdAt,
    };
  }

  async deleteLanding(slug: string) {
    const landing = await this.prisma.landing.findUnique({ where: { slug } });
    if (!landing) throw new NotFoundException('لندینگ یافت نشد');

    const { randomUUID } = await import('crypto');
    const idempotencyKey = `landing:${slug}:delete:${randomUUID()}`;

    // تراکنش: حذف لندینگ و افزودن ایونت به Outbox
    await this.prisma.$transaction(async (tx) => {
      await tx.landing.delete({ where: { slug } });
      await tx.outboxEvent.create({
        data: {
          eventType: 'landing.delete',
          idempotencyKey,
          payload: { slug, idempotencyKey },
        },
      });
    });

    // حذف فایل‌های فیزیکی
    const { rmSync } = await import('fs');

    // ۱. حذف فولدر استاتیک
    const staticDir = join(this.files.staticRoot, slug);
    if (existsSync(staticDir)) {
      rmSync(staticDir, { recursive: true, force: true });
    }

    // ۲. حذف پکیج ZIP
    const packageZip = join(this.files.tempRoot, 'packages', `${slug}.zip`);
    if (existsSync(packageZip)) {
      rmSync(packageZip, { force: true });
    }

    return { slug };
  }

  getImmutablePackagePath(slug: string, packageFile: string): string {
    const expectedPrefix = `${slug}-v`;
    if (
      !packageFile.startsWith(expectedPrefix) ||
      !/^[a-z0-9][a-z0-9._-]*\.zip$/i.test(packageFile)
    ) {
      throw new NotFoundException('Package not found');
    }

    const path = join(this.files.tempRoot, 'packages', packageFile);
    if (!existsSync(path)) {
      throw new NotFoundException('Package not found');
    }
    return path;
  }

  getPackagePath(slug: string): string {
    const path = join(this.files.tempRoot, 'packages', `${slug}.zip`);
    if (!existsSync(path)) {
      // اگه پکیج نبود از static دوباره بساز
      return this.files.packageLandingZip(slug);
    }
    return path;
  }

  /** لیست لندینگ‌ها و فرم‌ها برای Edgeهایی که AMQP ندارن (HTTP pull) */
  async getSyncManifest() {
    const masterInternalUrl =
      this.config.get<string>('masterInternalUrl') || 'http://localhost:3000';
    const masterUrl = masterInternalUrl.endsWith('/')
      ? masterInternalUrl.slice(0, -1)
      : masterInternalUrl;
    const publicBaseUrl = this.config.get<string>('publicBaseUrl');
    let publicBase = '';
    if (publicBaseUrl) {
      publicBase = publicBaseUrl.endsWith('/')
        ? publicBaseUrl.slice(0, -1)
        : publicBaseUrl;
    }
    const packagePath = (slug: string, version: number, checksum: string) =>
      `/api/internal/landings/${slug}/package/${slug}-v${version}-${checksum}.zip`;

    const rows = await this.prisma.landing.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
    });

    // فرم‌ها هم توی مانیفست — Edge بدون AMQP تعریف فرم رو از همین‌جا می‌گیره
    const forms = await this.prisma.form.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { category: true },
    });

    const settings = await this.prisma.systemSetting.findMany();

    return {
      landings: rows.map((row) => ({
        slug: row.slug,
        version: row.version,
        checksum: row.checksum,
        idempotencyKey: `landing:${row.slug}:v${row.version}:${row.checksum}`,
        downloadUrl: `${masterUrl}${packagePath(row.slug, row.version, row.checksum)}`,
        ...(publicBase
          ? {
              downloadUrlFallback: `${publicBase}${packagePath(row.slug, row.version, row.checksum)}`,
            }
          : {}),
      })),
      forms: forms.map((f) => ({
        id: f.id,
        title: f.title,
        category: f.category?.name || null,
        key: f.key,
        slug: f.slug,
        body: f.body,
        webhookUrl: f.webhookUrl,
        googleSheetUrl: f.googleSheetUrl,
        googleSheetMeta: f.googleSheetMeta,
        otpEnabled: f.otpEnabled,
        otpField: f.otpField,
        otpTemplate: f.otpTemplate,
        otpLength: f.otpLength,
        sendUtmToWebhook: f.sendUtmToWebhook,
        sendUtmToSheet: f.sendUtmToSheet,
        updatedAt: f.updatedAt.toISOString(),
        idempotencyKey: `form:${f.key}:${f.updatedAt.getTime()}`,
      })),
      settings: settings.map((s) => ({
        key: s.key,
        value: s.value,
      })),
    };
  }
}
