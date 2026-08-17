import { createHash, randomInt, timingSafeEqual } from 'crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isEdge, isMaster } from '../../config/role';
import { OutboxService } from '../sync/outbox.service';
import { WebhookService } from './webhook.service';
import { KavenegarService } from './kavenegar.service';
import { CategoryService } from '../categories/category.service';
import { CreateFormDto, UpdateFormDto } from './dto/form.dto';

@Injectable()
export class FormEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly webhook: WebhookService,
    private readonly kavenegar: KavenegarService,
    private readonly categories: CategoryService,
  ) {}

  list() {
    return this.prisma.form.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { category: true },
    });
  }

  listWithSubmissionCounts(q?: string) {
    const query = q?.trim();
    const where: Prisma.FormWhereInput | undefined = query
      ? {
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { key: { contains: query, mode: 'insensitive' } },
            { slug: { contains: query, mode: 'insensitive' } },
            { category: { name: { contains: query, mode: 'insensitive' } } },
          ],
        }
      : undefined;

    return this.prisma.form.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        category: true,
        _count: { select: { submissions: true } },
      },
    });
  }

  async getDashboardMetrics() {
    const [forms, edgeNodes] = await Promise.all([
      this.prisma.form.findMany({
        include: { _count: { select: { submissions: true } } },
      }),
      this.prisma.edgeNode.findMany({
        orderBy: { title: 'asc' },
        include: { _count: { select: { submissions: true } } },
      }),
    ]);

    const formsWithLeads = forms.filter(
      (form) => form._count.submissions > 0,
    ).length;
    const edgeLeads = edgeNodes.reduce(
      (total, node) => total + node._count.submissions,
      0,
    );

    return {
      formsWithLeads,
      formsWithoutLeads: forms.length - formsWithLeads,
      edgeLeads,
      edgeNodes: edgeNodes.map((node) => ({
        id: node.id,
        title: node.title,
        status: node.status,
        leadCount: node._count.submissions,
      })),
    };
  }

  async getById(id: string) {
    const form = await this.prisma.form.findUnique({
      where: { id },
      include: { category: true },
    });
    if (!form) throw new NotFoundException('Form not found');
    return form;
  }

  async getByKey(key: string) {
    const form = await this.prisma.form.findUnique({ where: { key } });
    if (!form) throw new NotFoundException('Form not found');
    return form;
  }

  async create(dto: CreateFormDto) {
    await this.categories.requireById(dto.categoryId);
    const form = await this.prisma.form.create({
      data: {
        title: dto.title,
        categoryId: dto.categoryId || null,
        key: dto.key,
        slug: dto.slug,
        body: dto.body as Prisma.InputJsonValue,
        webhookUrl: dto.webhookUrl || null,
        googleSheetUrl: dto.googleSheetUrl || null,
        googleSheetMeta: dto.googleSheetMeta
          ? (dto.googleSheetMeta as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        otpEnabled: dto.otpEnabled || false,
        otpField: dto.otpField || 'mobile',
        otpTemplate: dto.otpTemplate || 'verify',
        otpLength: dto.otpLength || 5,
        profileId: dto.profileId || null,
      },
      include: { category: true },
    });
    // تعریف فرم رو برای Edgeها می‌فرستیم
    if (isMaster()) {
      await this.enqueueFormUpsert(form);
    }
    return form;
  }

  async update(id: string, dto: UpdateFormDto) {
    await this.getById(id);
    if (dto.categoryId !== undefined) {
      await this.categories.requireById(dto.categoryId);
    }
    const form = await this.prisma.form.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.categoryId !== undefined
          ? { categoryId: dto.categoryId || null }
          : {}),
        ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
        ...(dto.body !== undefined
          ? { body: dto.body as Prisma.InputJsonValue }
          : {}),
        ...(dto.webhookUrl !== undefined
          ? { webhookUrl: dto.webhookUrl || null }
          : {}),
        ...(dto.googleSheetUrl !== undefined
          ? { googleSheetUrl: dto.googleSheetUrl || null }
          : {}),
        ...(dto.googleSheetMeta !== undefined
          ? {
              googleSheetMeta: dto.googleSheetMeta
                ? (dto.googleSheetMeta as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            }
          : {}),
        ...(dto.otpEnabled !== undefined ? { otpEnabled: dto.otpEnabled } : {}),
        ...(dto.otpField !== undefined
          ? { otpField: dto.otpField || 'mobile' }
          : {}),
        ...(dto.otpTemplate !== undefined
          ? { otpTemplate: dto.otpTemplate || 'verify' }
          : {}),
        ...(dto.otpLength !== undefined ? { otpLength: dto.otpLength } : {}),
        ...(dto.sendUtmToWebhook !== undefined
          ? { sendUtmToWebhook: dto.sendUtmToWebhook }
          : {}),
        ...(dto.sendUtmToSheet !== undefined
          ? { sendUtmToSheet: dto.sendUtmToSheet }
          : {}),
        ...(dto.profileId !== undefined
          ? { profileId: dto.profileId || null }
          : {}),
      },
      include: { category: true },
    });
    if (isMaster()) {
      await this.enqueueFormUpsert(form);
    }
    return form;
  }

  async remove(id: string) {
    const form = await this.getById(id);
    await this.prisma.form.delete({ where: { id } });
    if (isMaster()) {
      await this.outbox.enqueueFormSync({
        idempotencyKey: `form:delete:${form.key}:${Date.now()}`,
        action: 'delete',
        key: form.key,
      });
    }
    return { deleted: true };
  }

  async requestOtp(
    key: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true; submissionId: string; expiresAt: string }> {
    const form = await this.getByKey(key);
    if (!form.otpEnabled) {
      throw new BadRequestException('OTP is not enabled for this form');
    }

    this.validateRequiredFields(form.body, payload);

    const otpField = form.otpField || 'mobile';
    const mobile = this.normalizeMobile(payload[otpField]);
    if (!mobile) {
      throw new BadRequestException(`Field "${otpField}" is required`);
    }

    const length = form.otpLength || 5;
    const code = this.createOtpCode(length);
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000);
    const edgeNodeId = process.env.EDGE_NODE_ID || null;
    const safePayload = { ...payload, [otpField]: mobile };

    const submission = await this.prisma.$transaction(async (tx) => {
      const created = await tx.formSubmission.create({
        data: {
          formId: form.id,
          edgeNodeId,
          payload: safePayload as Prisma.InputJsonValue,
          otpStatus: 'UNVERIFIED',
        },
      });

      await tx.otpChallenge.create({
        data: {
          submissionId: created.id,
          mobile,
          codeHash: this.hashOtp(code),
          expiresAt,
        },
      });

      if (isEdge()) {
        await tx.outboxEvent.create({
          data: {
            eventType: 'form.submission.sync',
            idempotencyKey: `submission:${created.id}:v:1`,
            payload: this.submissionSyncPayload(
              created,
              form.key,
              edgeNodeId,
            ) as unknown as Prisma.InputJsonValue,
          },
        });
      }

      return created;
    });

    await this.kavenegar.sendLookupOtp(
      mobile,
      code,
      form.otpTemplate || 'verify',
    );

    if (!isEdge()) {
      void this.dispatchSubmission(form, submission);
    }

    return {
      ok: true,
      submissionId: submission.id,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verifyOtp(key: string, submissionId: string, code: string) {
    const form = await this.getByKey(key);
    if (!form.otpEnabled) {
      throw new BadRequestException('OTP is not enabled for this form');
    }
    if (!submissionId || !code?.trim()) {
      throw new BadRequestException('submissionId and code are required');
    }

    const edgeNodeId = process.env.EDGE_NODE_ID || null;
    const result = await this.prisma.$transaction(async (tx) => {
      const challenge = await tx.otpChallenge.findUnique({
        where: { submissionId },
        include: { submission: true },
      });
      if (!challenge || challenge.submission.formId !== form.id) {
        throw new NotFoundException('OTP challenge not found');
      }

      if (
        challenge.verifiedAt ||
        challenge.submission.otpStatus === 'VERIFIED'
      ) {
        return { submission: challenge.submission, wasVerified: false };
      }
      if (challenge.expiresAt <= new Date()) {
        throw new BadRequestException('OTP has expired');
      }

      if (!this.matchesOtp(code, challenge.codeHash)) {
        await tx.otpChallenge.update({
          where: { id: challenge.id },
          data: { attempts: { increment: 1 } },
        });
        throw new BadRequestException('Invalid OTP code');
      }

      const verifiedAt = new Date();
      const transitioned = await tx.formSubmission.updateMany({
        where: { id: submissionId, otpStatus: 'UNVERIFIED' },
        data: {
          otpStatus: 'VERIFIED',
          verifiedAt,
          syncVersion: { increment: 1 },
        },
      });
      if (!transitioned.count) {
        const current = await tx.formSubmission.findUniqueOrThrow({
          where: { id: submissionId },
        });
        return { submission: current, wasVerified: false };
      }

      const submission = await tx.formSubmission.findUniqueOrThrow({
        where: { id: submissionId },
      });
      await tx.otpChallenge.update({
        where: { id: challenge.id },
        data: { verifiedAt, codeHash: '' },
      });

      if (isEdge()) {
        await tx.outboxEvent.create({
          data: {
            eventType: 'form.submission.sync',
            idempotencyKey: `submission:${submission.id}:v:${submission.syncVersion}`,
            payload: this.submissionSyncPayload(
              submission,
              form.key,
              edgeNodeId,
            ) as unknown as Prisma.InputJsonValue,
          },
        });
      }

      return { submission, wasVerified: true };
    });

    return {
      ok: true,
      submissionId: result.submission.id,
      otpStatus: result.submission.otpStatus,
    };
  }

  async submit(key: string, payload: Record<string, unknown>) {
    const form = await this.getByKey(key);
    if (form.otpEnabled) {
      throw new BadRequestException(
        'Use the OTP request and verification flow for this form',
      );
    }

    this.validateRequiredFields(form.body, payload);
    const edgeNodeId = process.env.EDGE_NODE_ID || null;
    const submission = await this.prisma.$transaction(async (tx) => {
      const created = await tx.formSubmission.create({
        data: {
          formId: form.id,
          edgeNodeId,
          payload: payload as Prisma.InputJsonValue,
          otpStatus: 'NOT_REQUIRED',
        },
      });
      if (isEdge()) {
        await tx.outboxEvent.create({
          data: {
            eventType: 'form.submission.sync',
            idempotencyKey: `submission:${created.id}:v:1`,
            payload: this.submissionSyncPayload(
              created,
              form.key,
              edgeNodeId,
            ) as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return created;
    });

    if (!isEdge()) {
      void this.dispatchSubmission(form, submission);
    }
    return submission;
  }

  private validateRequiredFields(
    body: unknown,
    payload: Record<string, unknown>,
  ) {
    const fields = Array.isArray(body)
      ? (body as Array<Record<string, unknown>>)
      : [];
    for (const field of fields) {
      const name = typeof field.name === 'string' ? field.name : '';
      if (
        field.required &&
        (payload[name] === undefined || payload[name] === '')
      ) {
        throw new BadRequestException(`Field "${name}" is required`);
      }
    }
  }

  private normalizeMobile(value: unknown) {
    return (typeof value === 'string' ? value : '')
      .trim()
      .replace(/[\s()-]/g, '');
  }

  private createOtpCode(length: number) {
    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length);
    return randomInt(min, max).toString();
  }

  private hashOtp(code: string) {
    return createHash('sha256').update(code).digest('hex');
  }

  private matchesOtp(code: string, expectedHash: string) {
    const actual = Buffer.from(this.hashOtp(code));
    const expected = Buffer.from(expectedHash);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private submissionSyncPayload(
    submission: {
      id: string;
      payload: Prisma.JsonValue;
      createdAt: Date;
      otpStatus: string | null;
      syncVersion: number;
      verifiedAt: Date | null;
    },
    formKey: string,
    edgeNodeId: string | null,
  ) {
    return {
      idempotencyKey: `submission:${submission.id}:v:${submission.syncVersion}`,
      submissionId: submission.id,
      formKey,
      edgeNodeId: edgeNodeId || undefined,
      payload: submission.payload as Record<string, unknown>,
      otpStatus: submission.otpStatus || 'NOT_REQUIRED',
      syncVersion: submission.syncVersion,
      createdAt: submission.createdAt.toISOString(),
      verifiedAt: submission.verifiedAt?.toISOString() || null,
    };
  }

  private async dispatchSubmission(
    form: Parameters<WebhookService['dispatch']>[0],
    submission: { id: string; payload: Prisma.JsonValue; createdAt: Date },
  ) {
    try {
      await this.webhook.dispatch(form, {
        id: submission.id,
        payload: submission.payload as Record<string, unknown>,
        createdAt: submission.createdAt,
      });
    } catch (err) {
      console.error('Error dispatching webhook in background:', err);
    }
  }

  async listWebhookInvocations(page?: number, pageSize?: number) {
    if (page !== undefined && pageSize !== undefined) {
      const skip = (page - 1) * pageSize;
      const [total, items] = await this.prisma.$transaction([
        this.prisma.webhookInvocation.count(),
        this.prisma.webhookInvocation.findMany({
          include: {
            submission: {
              include: {
                form: { select: { title: true, key: true } },
                edgeNode: { select: { title: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: pageSize,
        }),
      ]);

      return {
        items,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
        },
      };
    }

    const items = await this.prisma.webhookInvocation.findMany({
      include: {
        submission: {
          include: {
            form: { select: { title: true, key: true } },
            edgeNode: { select: { title: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      items,
      pagination: {
        page: 1,
        pageSize: items.length,
        total: items.length,
        totalPages: 1,
      },
    };
  }

  listFailedWebhooks() {
    return this.prisma.formSubmission.findMany({
      where: { webhookStatus: 'FAILED' },
      include: {
        form: { select: { title: true, key: true } },
        edgeNode: { select: { title: true, host: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  listSubmissions(
    formId?: string,
    fromDate?: Date,
    toDate?: Date,
    otpFilter?: string,
    utmFilter?: string,
    limit?: number,
  ) {
    const where: Prisma.FormSubmissionWhereInput = {};
    if (formId) where.formId = formId;

    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) where.createdAt.gte = fromDate;
      if (toDate) where.createdAt.lte = toDate;
    }

    if (otpFilter === 'VERIFIED') {
      where.otpStatus = 'VERIFIED';
    } else if (otpFilter === 'UNVERIFIED') {
      where.otpStatus = 'UNVERIFIED';
    }

    if (utmFilter) {
      where.payload = {
        string_contains: utmFilter,
      };
    }

    return this.prisma.formSubmission.findMany({
      where,
      include: {
        form: {
          select: { title: true, key: true },
        },
        edgeNode: {
          select: { title: true, host: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      ...(limit !== undefined ? { take: limit } : {}),
    });
  }

  private async enqueueFormUpsert(form: {
    id: string;
    title: string;
    category?: { name: string } | null;
    key: string;
    slug: string;
    body: unknown;
    webhookUrl?: string | null;
    googleSheetUrl?: string | null;
    googleSheetMeta?: unknown;
    otpEnabled?: boolean;
    otpField?: string | null;
    otpTemplate?: string | null;
    otpLength?: number;
    sendUtmToWebhook?: boolean;
    sendUtmToSheet?: boolean;
    updatedAt: Date;
  }) {
    await this.outbox.enqueueFormSync({
      idempotencyKey: `form:upsert:${form.key}:${form.updatedAt.getTime()}`,
      action: 'upsert',
      key: form.key,
      form: {
        id: form.id,
        title: form.title,
        category: form.category?.name || null,
        key: form.key,
        slug: form.slug,
        body: form.body,
        webhookUrl: form.webhookUrl,
        googleSheetUrl: form.googleSheetUrl,
        googleSheetMeta: form.googleSheetMeta,
        otpEnabled: form.otpEnabled,
        otpField: form.otpField,
        otpTemplate: form.otpTemplate,
        otpLength: form.otpLength,
        sendUtmToWebhook: form.sendUtmToWebhook,
        sendUtmToSheet: form.sendUtmToSheet,
      },
    });
  }
}
