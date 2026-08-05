import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isEdge, isMaster } from '../../config/role';
import { LandingApplyService } from './landing-apply.service';
import { WebhookService } from '../form-engine/webhook.service';
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
    private readonly landingApply: LandingApplyService,
    private readonly webhook: WebhookService,
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

      if (await this.landingApply.alreadyProcessed(payload.idempotencyKey)) {
        channel.ack(originalMsg);
        return;
      }

      await this.landingApply.applyLanding(payload);
      await this.landingApply.markProcessed(payload.idempotencyKey);
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

      if (await this.landingApply.alreadyProcessed(payload.idempotencyKey)) {
        channel.ack(originalMsg);
        return;
      }

      if (payload.action === 'delete') {
        await this.prisma.form.deleteMany({ where: { key: payload.key } });
      } else if (payload.form) {
        await this.prisma.form.upsert({
          where: { key: payload.form.key },
          create: {
            id: payload.form.id,
            title: payload.form.title,
            key: payload.form.key,
            slug: payload.form.slug,
            body: payload.form.body as Prisma.InputJsonValue,
            webhookUrl: payload.form.webhookUrl || null,
            googleSheetUrl: payload.form.googleSheetUrl || null,
            googleSheetMeta: payload.form.googleSheetMeta ? (payload.form.googleSheetMeta as Prisma.InputJsonValue) : Prisma.JsonNull,
          },
          update: {
            title: payload.form.title,
            slug: payload.form.slug,
            body: payload.form.body as Prisma.InputJsonValue,
            webhookUrl: payload.form.webhookUrl || null,
            googleSheetUrl: payload.form.googleSheetUrl || null,
            googleSheetMeta: payload.form.googleSheetMeta ? (payload.form.googleSheetMeta as Prisma.InputJsonValue) : Prisma.JsonNull,
          },
        });
      }

      await this.landingApply.markProcessed(payload.idempotencyKey);
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

      if (await this.landingApply.alreadyProcessed(payload.idempotencyKey)) {
        channel.ack(originalMsg);
        return;
      }

      const form = await this.prisma.form.findUnique({
        where: { key: payload.formKey },
      });
      if (!form) {
        throw new Error(`Form not found on master: ${payload.formKey}`);
      }

      await this.prisma.formSubmission.upsert({
        where: { id: payload.submissionId },
        create: {
          id: payload.submissionId,
          formId: form.id,
          edgeNodeId: payload.edgeNodeId || null,
          payload: payload.payload as Prisma.InputJsonValue,
          createdAt: new Date(payload.createdAt),
        },
        update: {
          edgeNodeId: payload.edgeNodeId || null,
        },
      });

      await this.landingApply.markProcessed(payload.idempotencyKey);
      this.logger.log(
        `Form submission synced on master: ${payload.submissionId}`,
      );

      // اجرای وب‌هوک و اتصال گوگل‌شیت به صورت متمرکز روی مستر
      await this.webhook.dispatch(form, {
        id: payload.submissionId,
        payload: payload.payload as Record<string, unknown>,
        createdAt: new Date(payload.createdAt),
      });

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

  private fail(
    err: unknown,
    channel: {
      nack: (msg: unknown, allUpTo: boolean, requeue: boolean) => void;
    },
    originalMsg: unknown,
  ) {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`Sync failed: ${message}`);
    channel.nack(originalMsg, false, true);
  }
}
