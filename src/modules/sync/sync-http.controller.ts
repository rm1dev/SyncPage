import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isMaster } from '../../config/role';
import { LandingApplyService } from './landing-apply.service';
import { FormSubmissionSyncPayload } from './sync.types';

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
  ) {}

  @Post('api/internal/sync/submissions')
  async receiveSubmission(@Body() body: unknown) {
    // فقط Master سابمیشن قبول می‌کنه — روی Edge این مسیر معنی نداره
    if (!isMaster()) {
      throw new NotFoundException('Not available on this node');
    }

    const payload = body as Partial<FormSubmissionSyncPayload>;
    if (
      !payload?.idempotencyKey ||
      !payload.submissionId ||
      !payload.formKey ||
      !payload.createdAt
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

    await this.prisma.formSubmission.upsert({
      where: { id: payload.submissionId },
      create: {
        id: payload.submissionId,
        formId: form.id,
        payload: (payload.payload ?? {}) as Prisma.InputJsonValue,
        createdAt: new Date(payload.createdAt),
      },
      update: {},
    });

    await this.landingApply.markProcessed(payload.idempotencyKey);
    this.logger.log(
      `Form submission received via HTTP push: ${payload.submissionId}`,
    );
    return { ok: true };
  }
}
