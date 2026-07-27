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
    const checksum = this.files.checksumFile(zipPath);

    // ZIP اصلی رو نگه می‌داریم برای confirm و sync
    const storedZip = join(this.files.tempRoot, 'packages', `${previewId}.zip`);
    const { copyFileSync } = await import('fs');
    copyFileSync(zipPath, storedZip);

    return {
      previewId,
      slug,
      checksum,
      previewUrl: `/preview/${previewId}/`,
      storedZip,
    };
  }

  async confirm(previewId: string, slug: string) {
    const previewDir = join(this.files.tempRoot, 'preview', previewId);
    const storedZip = join(this.files.tempRoot, 'packages', `${previewId}.zip`);

    if (!existsSync(previewDir) || !existsSync(storedZip)) {
      throw new NotFoundException('Preview not found or expired');
    }

    const checksum = this.files.checksumFile(storedZip);
    this.files.replaceLandingAtomic(slug, previewDir);

    const existing = await this.prisma.landing.findUnique({ where: { slug } });
    const version = existing ? existing.version + 1 : 1;

    this.files.checksumDirMarker(slug, version, checksum);

    // ZIP نهایی برای دانلود Edge با نام slug
    const { copyFileSync, unlinkSync } = await import('fs');
    const finalZip = join(this.files.tempRoot, 'packages', `${slug}.zip`);
    copyFileSync(storedZip, finalZip);

    const masterUrl =
      this.config.get<string>('masterInternalUrl') || 'http://localhost:3000';
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
            downloadUrl: `${masterUrl}/api/internal/landings/${slug}/package`,
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
}
