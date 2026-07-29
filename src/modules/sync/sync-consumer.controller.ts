import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import axios from 'axios';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FileService } from '../deployment/file.service';
import { isEdge, isMaster } from '../../config/role';
import {
  FormSubmissionSyncPayload,
  FormSyncPayload,
  LandingSyncPayload,
} from './sync.types';

@Controller()
export class SyncConsumerController {
  private readonly logger = new Logger(SyncConsumerController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FileService,
  ) {}

  @EventPattern('landing.sync')
  async handleLandingSync(
    @Payload()
    raw:
      | LandingSyncPayload
      | { pattern?: string; data?: LandingSyncPayload },
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();
    const payload = this.unwrap<LandingSyncPayload>(raw);

    try {
      if (!isEdge()) {
        this.logger.warn('Ignoring landing.sync on non-EDGE node');
        channel.ack(originalMsg);
        return;
      }

      if (!payload?.idempotencyKey || !payload.slug || !payload.downloadUrl) {
        this.logger.error('Invalid landing.sync payload');
        channel.ack(originalMsg);
        return;
      }

      if (await this.alreadyProcessed(payload.idempotencyKey)) {
        channel.ack(originalMsg);
        return;
      }

      await this.applyLanding(payload);
      await this.markProcessed(payload.idempotencyKey);
      this.logger.log(
        `Landing synced on edge: ${payload.slug} v${payload.version}`,
      );
      channel.ack(originalMsg);
    } catch (err) {
      this.fail(err, channel, originalMsg);
    }
  }

  @EventPattern('form.sync')
  async handleFormSync(
    @Payload()
    raw: FormSyncPayload | { pattern?: string; data?: FormSyncPayload },
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();
    const payload = this.unwrap<FormSyncPayload>(raw);

    try {
      if (!isEdge()) {
        this.logger.warn('Ignoring form.sync on non-EDGE node');
        channel.ack(originalMsg);
        return;
      }

      if (!payload?.idempotencyKey || !payload.key || !payload.action) {
        this.logger.error('Invalid form.sync payload');
        channel.ack(originalMsg);
        return;
      }

      if (await this.alreadyProcessed(payload.idempotencyKey)) {
        channel.ack(originalMsg);
        return;
      }

      if (payload.action === 'delete') {
        await this.prisma.form.deleteMany({ where: { key: payload.key } });
      } else if (payload.form) {
        // تعریف فرم رو با همون id مستر می‌ذاریم که سازگار بمونه
        await this.prisma.form.upsert({
          where: { key: payload.form.key },
          create: {
            id: payload.form.id,
            title: payload.form.title,
            key: payload.form.key,
            slug: payload.form.slug,
            body: payload.form.body as Prisma.InputJsonValue,
          },
          update: {
            title: payload.form.title,
            slug: payload.form.slug,
            body: payload.form.body as Prisma.InputJsonValue,
          },
        });
      }

      await this.markProcessed(payload.idempotencyKey);
      this.logger.log(`Form synced on edge: ${payload.key} (${payload.action})`);
      channel.ack(originalMsg);
    } catch (err) {
      this.fail(err, channel, originalMsg);
    }
  }

  @EventPattern('form.submission.sync')
  async handleFormSubmissionSync(
    @Payload()
    raw:
      | FormSubmissionSyncPayload
      | { pattern?: string; data?: FormSubmissionSyncPayload },
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();
    const payload = this.unwrap<FormSubmissionSyncPayload>(raw);

    try {
      if (!isMaster()) {
        this.logger.warn('Ignoring form.submission.sync on non-MASTER node');
        channel.ack(originalMsg);
        return;
      }

      if (
        !payload?.idempotencyKey ||
        !payload.submissionId ||
        !payload.formKey
      ) {
        this.logger.error('Invalid form.submission.sync payload');
        channel.ack(originalMsg);
        return;
      }

      if (await this.alreadyProcessed(payload.idempotencyKey)) {
        channel.ack(originalMsg);
        return;
      }

      const form = await this.prisma.form.findUnique({
        where: { key: payload.formKey },
      });
      if (!form) {
        throw new Error(`Form not found on master: ${payload.formKey}`);
      }

      // با همون id لبه upsert می‌کنیم تا روی DB مشترک هم تکراری نشه
      await this.prisma.formSubmission.upsert({
        where: { id: payload.submissionId },
        create: {
          id: payload.submissionId,
          formId: form.id,
          payload: payload.payload as Prisma.InputJsonValue,
          createdAt: new Date(payload.createdAt),
        },
        update: {},
      });

      await this.markProcessed(payload.idempotencyKey);
      this.logger.log(
        `Form submission synced on master: ${payload.submissionId}`,
      );
      channel.ack(originalMsg);
    } catch (err) {
      this.fail(err, channel, originalMsg);
    }
  }

  private unwrap<T>(raw: T | { pattern?: string; data?: T }): T {
    if (raw && typeof raw === 'object' && 'data' in raw && raw.data) {
      return raw.data;
    }
    return raw as T;
  }

  private async alreadyProcessed(idempotencyKey: string) {
    const existing = await this.prisma.processedEvent.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      this.logger.log(`Duplicate sync ignored (idempotent): ${idempotencyKey}`);
      return true;
    }
    return false;
  }

  private markProcessed(idempotencyKey: string) {
    return this.prisma.processedEvent.create({
      data: { idempotencyKey },
    });
  }

  private fail(
    err: unknown,
    channel: { nack: (msg: unknown, allUpTo: boolean, requeue: boolean) => void },
    originalMsg: unknown,
  ) {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`Sync failed: ${message}`);
    channel.nack(originalMsg, false, true);
  }

  private async applyLanding(payload: LandingSyncPayload) {
    this.files.ensureDirs();
    const zipPath = join(
      this.files.tempRoot,
      'packages',
      `edge-${payload.slug}-${payload.version}.zip`,
    );
    const extractDir = join(
      this.files.tempRoot,
      'preview',
      `edge-${payload.slug}-${payload.version}`,
    );

    await this.downloadWithFallback(payload, zipPath);

    const checksum = this.files.checksumFile(zipPath);
    if (checksum !== payload.checksum) {
      throw new Error(
        `Checksum mismatch for ${payload.slug}: expected ${payload.checksum}, got ${checksum}`,
      );
    }

    this.files.extractZip(zipPath, extractDir);
    this.files.replaceLandingAtomic(payload.slug, extractDir);
    this.files.checksumDirMarker(payload.slug, payload.version, checksum);

    await this.prisma.landing.upsert({
      where: { slug: payload.slug },
      create: {
        slug: payload.slug,
        version: payload.version,
        checksum: payload.checksum,
        status: 'ACTIVE',
      },
      update: {
        version: payload.version,
        checksum: payload.checksum,
        status: 'ACTIVE',
      },
    });
  }

  private async downloadWithFallback(
    payload: LandingSyncPayload,
    dest: string,
  ) {
    const candidates = [payload.downloadUrl];
    if (
      payload.downloadUrlFallback &&
      payload.downloadUrlFallback !== payload.downloadUrl
    ) {
      candidates.push(payload.downloadUrlFallback);
    }
    // از env لبه هم به‌عنوان آخرین شانس
    const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (publicBase) {
      try {
        const path = new URL(payload.downloadUrl).pathname;
        const viaPublic = `${publicBase}${path}`;
        if (!candidates.includes(viaPublic)) candidates.push(viaPublic);
      } catch {
        /* ignore */
      }
    }

    let lastErr: unknown;
    for (const url of candidates) {
      try {
        this.logger.log(`Downloading landing package: ${url}`);
        await this.downloadFile(url, dest);
        return;
      } catch (err) {
        lastErr = err;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Download failed (${url}): ${message}`);
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Failed to download package for ${payload.slug}`);
  }

  private async downloadFile(url: string, dest: string) {
    const dir = join(dest, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 120_000,
      maxRedirects: 5,
      validateStatus: (s: number) => s >= 200 && s < 300,
    });
    await pipeline(response.data, createWriteStream(dest));
  }
}
