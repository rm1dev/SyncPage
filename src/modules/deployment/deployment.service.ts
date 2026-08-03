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

@Injectable()
export class DeploymentService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FileService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.files.ensureDirs();
  }

  listLandings() {
    return this.prisma.landing.findMany({ orderBy: { updatedAt: 'desc' } });
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

    const publicBase = (
      this.config.get<string>('publicBaseUrl') || ''
    ).replace(/\/$/, '');
    const previewPath = `/preview/${previewId}/`;

    return {
      previewId,
      slug,
      checksum,
      previewUrl: publicBase ? `${publicBase}${previewPath}` : previewPath,
      storedZip,
    };
  }

  async confirm(previewId: string, slug: string) {
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

    // ZIP نهایی برای دانلود Edge با نام slug
    const { copyFileSync, unlinkSync } = await import('fs');
    const finalZip = join(this.files.tempRoot, 'packages', `${slug}.zip`);
    copyFileSync(storedZip, finalZip);

    const masterUrl = (
      this.config.get<string>('masterInternalUrl') || 'http://localhost:3000'
    ).replace(/\/$/, '');
    const publicBase = (
      this.config.get<string>('publicBaseUrl') || ''
    ).replace(/\/$/, '');
    const packagePath = `/api/internal/landings/${slug}/package`;
    const idempotencyKey = `landing:${slug}:v${version}:${checksum}`;

    const landing = await this.prisma.$transaction(async (tx) => {
      const row = await tx.landing.upsert({
        where: { slug },
        create: {
          slug,
          version,
          checksum,
          status: 'ACTIVE',
        },
        update: {
          version,
          checksum,
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
            // Edge اول از IP داخلی Master دانلود می‌کنه؛ اگه نشد public رو هم امتحان می‌کنه
            downloadUrl: `${masterUrl}${packagePath}`,
            ...(publicBase
              ? { downloadUrlFallback: `${publicBase}${packagePath}` }
              : {}),
          } as Prisma.InputJsonValue,
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
    const masterUrl = (
      this.config.get<string>('masterInternalUrl') || 'http://localhost:3000'
    ).replace(/\/$/, '');
    const publicBase = (
      this.config.get<string>('publicBaseUrl') || ''
    ).replace(/\/$/, '');
    const packagePath = (slug: string) =>
      `/api/internal/landings/${slug}/package`;

    const rows = await this.prisma.landing.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
    });

    // فرم‌ها هم توی مانیفست — Edge بدون AMQP تعریف فرم رو از همین‌جا می‌گیره
    const forms = await this.prisma.form.findMany({
      orderBy: { updatedAt: 'desc' },
    });

    return {
      landings: rows.map((row) => ({
        slug: row.slug,
        version: row.version,
        checksum: row.checksum,
        idempotencyKey: `landing:${row.slug}:v${row.version}:${row.checksum}`,
        downloadUrl: `${masterUrl}${packagePath(row.slug)}`,
        ...(publicBase
          ? { downloadUrlFallback: `${publicBase}${packagePath(row.slug)}` }
          : {}),
      })),
      forms: forms.map((f) => ({
        id: f.id,
        title: f.title,
        key: f.key,
        slug: f.slug,
        body: f.body,
        updatedAt: f.updatedAt.toISOString(),
        idempotencyKey: `form:${f.key}:${f.updatedAt.getTime()}`,
      })),
    };
  }
}
