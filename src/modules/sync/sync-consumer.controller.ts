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
            otpEnabled: payload.form.otpEnabled || false,
            otpField: payload.form.otpField || 'mobile',
            otpTemplate: payload.form.otpTemplate || 'verify',
            otpLength: payload.form.otpLength || 5,
            sendUtmToWebhook: payload.form.sendUtmToWebhook ?? true,
            sendUtmToSheet: payload.form.sendUtmToSheet ?? true,
          },
          update: {
            title: payload.form.title,
            slug: payload.form.slug,
            body: payload.form.body as Prisma.InputJsonValue,
            webhookUrl: payload.form.webhookUrl || null,
            googleSheetUrl: payload.form.googleSheetUrl || null,
            googleSheetMeta: payload.form.googleSheetMeta ? (payload.form.googleSheetMeta as Prisma.InputJsonValue) : Prisma.JsonNull,
            otpEnabled: payload.form.otpEnabled || false,
            otpField: payload.form.otpField || 'mobile',
            otpTemplate: payload.form.otpTemplate || 'verify',
            otpLength: payload.form.otpLength || 5,
            sendUtmToWebhook: payload.form.sendUtmToWebhook ?? true,
            sendUtmToSheet: payload.form.sendUtmToSheet ?? true,
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

  @EventPattern('setting.sync')
  async handleSettingSync(
    @Payload()
    raw:
      | { key: string; value: string }
      | { pattern?: string; data?: { key: string; value: string } },
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();
    const payload = this.unwrap<{ key: string; value: string }>(raw);

    try {
      if (!isEdge()) {
        this.logger.warn('Ignoring setting.sync on non-EDGE node');
        channel.ack(originalMsg);
        return;
      }

      if (!payload?.key || !payload.value) {
        this.logger.error('Invalid setting.sync payload');
        channel.ack(originalMsg);
        return;
      }

      await this.prisma.systemSetting.upsert({
        where: { key: payload.key },
        create: { key: payload.key, value: payload.value },
        update: { value: payload.value },
      });

      this.logger.log(`Setting synced on edge: ${payload.key}`);
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
    const payloadRaw = this.unwrap<FormSubmissionSyncPayload>(raw);

    try {
      if (!isMaster()) {
        this.logger.warn('Ignoring form.submission.sync on non-MASTER node');
        channel.ack(originalMsg);
        return;
      }

      if (
        !payloadRaw?.idempotencyKey ||
        !payloadRaw.submissionId ||
        !payloadRaw.formKey
      ) {
        this.logger.error('Invalid form.submission.sync payload');
        channel.ack(originalMsg);
        return;
      }

      if (await this.landingApply.alreadyProcessed(payloadRaw.idempotencyKey)) {
        channel.ack(originalMsg);
        return;
      }

      const form = await this.prisma.form.findUnique({
        where: { key: payloadRaw.formKey },
      });
      if (!form) {
        throw new Error(`Form not found on master: ${payloadRaw.formKey}`);
      }

      const payload = { ...payloadRaw.payload };
      const otpStatus = payload.__otpStatus ? String(payload.__otpStatus) : null;
      delete payload.__otpStatus;

      await this.prisma.formSubmission.upsert({
        where: { id: payloadRaw.submissionId },
        create: {
          id: payloadRaw.submissionId,
          formId: form.id,
          edgeNodeId: payloadRaw.edgeNodeId || null,
          payload: payload as Prisma.InputJsonValue,
          otpStatus,
          createdAt: new Date(payloadRaw.createdAt),
        },
        update: {
          edgeNodeId: payloadRaw.edgeNodeId || null,
          otpStatus,
        },
      });

      await this.landingApply.markProcessed(payloadRaw.idempotencyKey);
      this.logger.log(
        `Form submission synced on master: ${payloadRaw.submissionId}`,
      );

      // اجرای وب‌هوک و اتصال گوگل‌شیت به صورت متمرکز روی مستر
      await this.webhook.dispatch(form, {
        id: payloadRaw.submissionId,
        payload: payload as Record<string, unknown>,
        createdAt: new Date(payloadRaw.createdAt),
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
