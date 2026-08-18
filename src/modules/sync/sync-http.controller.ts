import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isMaster } from '../../config/role';
import { LandingApplyService } from './landing-apply.service';
import { FormSubmissionSyncPayload } from './sync.types';
import { WebhookService } from '../form-engine/webhook.service';
import { SyncAuthGuard } from '../../common/guards/sync-auth.guard';

/**
 * مسیر HTTP برای سابمیشن‌های Edge→Master —
 * وقتی AMQP روی مسیر بین‌الملل ناپایداره، outbox نود از همین جا push می‌کنه
 */
@Controller()
export class SyncHttpController {
  private readonly logger = new Logger(SyncHttpController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly landingApply: LandingApplyService,
    private readonly webhook: WebhookService,
  ) {}

  @Post('api/internal/sync/submissions')
  @UseGuards(SyncAuthGuard)
  async receiveSubmission(@Body() body: unknown) {
    if (!isMaster()) {
      throw new NotFoundException('Not available on this node');
    }
    return this.processSubmission(body as Partial<FormSubmissionSyncPayload>);
  }

  @Post('api/internal/sync/submissions/batch')
  @UseGuards(SyncAuthGuard)
  async receiveSubmissionBatch(@Body() body: { items: Partial<FormSubmissionSyncPayload>[] }) {
    if (!isMaster()) {
      throw new NotFoundException('Not available on this node');
    }
    if (!body || !Array.isArray(body.items)) {
      throw new BadRequestException('items array is required');
    }
    
    // limit batch size to 20
    const items = body.items.slice(0, 20);
    const results = [];

    for (const item of items) {
      try {
        const res = await this.processSubmission(item);
        results.push({
          idempotencyKey: item.idempotencyKey,
          status: res.duplicate ? 'duplicate' : 'accepted',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          idempotencyKey: item.idempotencyKey,
          status: 'failed',
          error: message,
        });
      }
    }

    return { ok: true, results };
  }

  private async processSubmission(payload: Partial<FormSubmissionSyncPayload>) {
    // فقط Master سابمیشن قبول می‌کنه — روی Edge این مسیر معنی نداره
    if (!isMaster()) {
      throw new NotFoundException('Not available on this node');
    }

    if (
      !payload?.idempotencyKey ||
      !payload.submissionId ||
      !payload.formKey ||
      !payload.createdAt ||
      !Number.isInteger(payload.syncVersion) ||
      payload.syncVersion! < 1 ||
      !payload.otpStatus ||
      !['NOT_REQUIRED', 'UNVERIFIED', 'VERIFIED'].includes(payload.otpStatus)
    ) {
      throw new BadRequestException(
        'idempotencyKey, submissionId, formKey and createdAt are required',
      );
    }

    // ارسال تکراری (retry از سمت نود) بی‌صدا OK می‌گیره
    if (await this.landingApply.alreadyProcessed(payload.idempotencyKey)) {
      return { ok: true, duplicate: true };
    }

    const form = await this.prisma.form.findUnique({
      where: { key: payload.formKey },
    });
    if (!form) {
      throw new BadRequestException(
        `Form not found on master: ${payload.formKey}`,
      );
    }

    const payloadData = { ...(payload.payload || {}) };
    const existing = await this.prisma.formSubmission.findUnique({
      where: { id: payload.submissionId },
    });
    const isNewer = !existing || payload.syncVersion! > existing.syncVersion;

    if (isNewer) {
      await this.prisma.formSubmission.upsert({
        where: { id: payload.submissionId },
        create: {
          id: payload.submissionId,
          formId: form.id,
          edgeNodeId: payload.edgeNodeId || null,
          payload: payloadData as Prisma.InputJsonValue,
          otpStatus: payload.otpStatus,
          syncVersion: payload.syncVersion,
          createdAt: new Date(payload.createdAt),
          verifiedAt: payload.verifiedAt ? new Date(payload.verifiedAt) : null,
        },
        update: {
          edgeNodeId: payload.edgeNodeId || null,
          otpStatus: payload.otpStatus,
          syncVersion: payload.syncVersion,
          verifiedAt: payload.verifiedAt ? new Date(payload.verifiedAt) : null,
        },
      });
    }

    await this.landingApply.markProcessed(payload.idempotencyKey);
    this.logger.log(
      `Form submission received via HTTP push: ${payload.submissionId}`,
    );

    // به‌روزرسانی تایید OTP نباید لید را دوباره به وب‌هوک/شیت ارسال کند.
    if (!existing && isNewer) {
      await this.webhook.dispatch(form, {
        id: payload.submissionId,
        payload: payloadData,
        createdAt: new Date(payload.createdAt),
      });
    }

    return { ok: true, duplicate: false };
  }
}
