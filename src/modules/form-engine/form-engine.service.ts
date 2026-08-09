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
import { CreateFormDto, UpdateFormDto } from './dto/form.dto';

@Injectable()
export class FormEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly webhook: WebhookService,
    private readonly kavenegar: KavenegarService,
  ) {}

  list() {
    return this.prisma.form.findMany({ orderBy: { updatedAt: 'desc' } });
  }

  async getById(id: string) {
    const form = await this.prisma.form.findUnique({ where: { id } });
    if (!form) throw new NotFoundException('Form not found');
    return form;
  }

  async getByKey(key: string) {
    const form = await this.prisma.form.findUnique({ where: { key } });
    if (!form) throw new NotFoundException('Form not found');
    return form;
  }

  async create(dto: CreateFormDto) {
    const form = await this.prisma.form.create({
      data: {
        title: dto.title,
        key: dto.key,
        slug: dto.slug,
        body: dto.body as Prisma.InputJsonValue,
        webhookUrl: dto.webhookUrl || null,
        googleSheetUrl: dto.googleSheetUrl || null,
        googleSheetMeta: dto.googleSheetMeta ? (dto.googleSheetMeta as Prisma.InputJsonValue) : Prisma.JsonNull,
        otpEnabled: dto.otpEnabled || false,
        otpField: dto.otpField || 'mobile',
        otpTemplate: dto.otpTemplate || 'verify',
        otpLength: dto.otpLength || 5,
        profileId: dto.profileId || null,
      },
    });
    // تعریف فرم رو برای Edgeها می‌فرستیم
    if (isMaster()) {
      await this.enqueueFormUpsert(form);
    }
    return form;
  }

  async update(id: string, dto: UpdateFormDto) {
    await this.getById(id);
    const form = await this.prisma.form.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
        ...(dto.body !== undefined
          ? { body: dto.body as Prisma.InputJsonValue }
          : {}),
        ...(dto.webhookUrl !== undefined ? { webhookUrl: dto.webhookUrl || null } : {}),
        ...(dto.googleSheetUrl !== undefined ? { googleSheetUrl: dto.googleSheetUrl || null } : {}),
        ...(dto.googleSheetMeta !== undefined ? { googleSheetMeta: dto.googleSheetMeta ? (dto.googleSheetMeta as Prisma.InputJsonValue) : Prisma.JsonNull } : {}),
        ...(dto.otpEnabled !== undefined ? { otpEnabled: dto.otpEnabled } : {}),
        ...(dto.otpField !== undefined ? { otpField: dto.otpField || 'mobile' } : {}),
        ...(dto.otpTemplate !== undefined ? { otpTemplate: dto.otpTemplate || 'verify' } : {}),
        ...(dto.otpLength !== undefined ? { otpLength: dto.otpLength } : {}),
        ...(dto.sendUtmToWebhook !== undefined ? { sendUtmToWebhook: dto.sendUtmToWebhook } : {}),
        ...(dto.sendUtmToSheet !== undefined ? { sendUtmToSheet: dto.sendUtmToSheet } : {}),
        ...(dto.profileId !== undefined ? { profileId: dto.profileId || null } : {}),
      },
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

  // کدهای موقت OTP در حافظه (با منقضی شدن بعد از ۲ دقیقه)
  private otpStore = new Map<
    string,
    {
      code: string;
      expiresAt: number;
      timeoutId?: NodeJS.Timeout;
    }
  >();

  async requestOtp(key: string, mobile: string) {
    const form = await this.getByKey(key);
    if (!form.otpEnabled) {
      throw new BadRequestException('OTP is not enabled for this form');
    }

    const template = form.otpTemplate || 'verify';
    const length = form.otpLength || 5;
    
    // تولید کد تصادفی با طول مشخص
    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length) - 1;
    const code = Math.floor(min + Math.random() * (max - min + 1)).toString();
    
    const expiresAt = Date.now() + 2 * 60 * 1000;
    const cacheKey = `${key}:${mobile.trim()}`;

    // پاکسازی تایمر قبلی اگر وجود داشت
    const prev = this.otpStore.get(cacheKey);
    if (prev?.timeoutId) {
      clearTimeout(prev.timeoutId);
    }

    // ایجاد تایمر برای ثبت رکورد در صورت عدم وریفای بعد از ۳ دقیقه
    const timeoutId = setTimeout(async () => {
      const entry = this.otpStore.get(cacheKey);
      if (entry) {
        this.otpStore.delete(cacheKey);
        try {
          const otpField = form.otpField || 'mobile';
          const payload: Record<string, unknown> = {
            [otpField]: mobile.trim(),
          };
          await this.submit(key, payload, undefined);
        } catch {
          // خطا در سابمیت خودکار بعد از انقضا لاگ یا نادیده گرفته می‌شود
        }
      }
    }, 3 * 60 * 1000);

    this.otpStore.set(cacheKey, { code, expiresAt, timeoutId });

    const sent = await this.kavenegar.sendLookupOtp(mobile, code, template);
    return { ok: true, sent };
  }

  async verifyOtp(key: string, mobile: string, code: string): Promise<boolean> {
    const cacheKey = `${key}:${mobile.trim()}`;
    const entry = this.otpStore.get(cacheKey);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      this.otpStore.delete(cacheKey);
      return false;
    }
    const isValid = entry.code === code.trim();
    if (isValid) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      this.otpStore.delete(cacheKey);
    }
    return isValid;
  }

  async submit(key: string, payload: Record<string, unknown>, otpCode?: string) {
    const form = await this.getByKey(key);
    const fields = Array.isArray(form.body)
      ? (form.body as Array<Record<string, unknown>>)
      : [];

    for (const field of fields) {
      const name = String(field.name || '');
      if (field.required && (payload[name] === undefined || payload[name] === '')) {
        throw new BadRequestException(`Field "${name}" is required`);
      }
    }

    let otpStatus: string | null = null;
    if (form.otpEnabled) {
      const otpField = form.otpField || 'mobile';
      const mobileVal = String(payload[otpField] || '');
      if (mobileVal && otpCode) {
        const isVerified = await this.verifyOtp(key, mobileVal, otpCode);
        otpStatus = isVerified ? 'VERIFIED' : 'UNVERIFIED';
      } else {
        // حتی اگر کاربر کد را وارد نکرده باشد یا اشتباه باشد، ثبت می‌کنیم ولی UNVERIFIED می‌زنیم
        otpStatus = 'UNVERIFIED';
      }
    }

    // اول روی همین گره ذخیره می‌شه (Edge برای سرعت/در دسترس بودن)
    const edgeNodeId = process.env.EDGE_NODE_ID;
    
    let submission;
    try {
      submission = await this.prisma.formSubmission.create({
        data: {
          formId: form.id,
          edgeNodeId: edgeNodeId || null,
          payload: payload as Prisma.InputJsonValue,
          otpStatus,
        },
      });
    } catch (err: any) {
      // Fallback if EDGE_NODE_ID is invalid
      if (err.code === 'P2003' || err.message?.includes('Foreign key')) {
        submission = await this.prisma.formSubmission.create({
          data: {
            formId: form.id,
            edgeNodeId: null,
            payload: payload as Prisma.InputJsonValue,
            otpStatus,
          },
        });
      } else {
        throw err;
      }
    }

    // از Edge به Master همگام می‌کنیم؛ روی Master نیازی به outbox نیست
    if (isEdge()) {
      await this.outbox.enqueueFormSubmission({
        idempotencyKey: `submission:${submission.id}`,
        submissionId: submission.id,
        formKey: form.key,
        edgeNodeId,
        payload: { ...payload, __otpStatus: otpStatus },
        createdAt: submission.createdAt.toISOString(),
      });
    } else {
      // اگر روی Master هستیم، مستقیما وب‌هوک را فایر می‌کنیم
      await this.webhook.dispatch(form, {
        id: submission.id,
        payload: submission.payload as Record<string, unknown>,
        createdAt: submission.createdAt,
      });
    }

    return submission;
  }

  listFailedWebhooks() {
    return this.prisma.formSubmission.findMany({
      where: { webhookStatus: 'FAILED' },
      include: {
        form: { select: { title: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  listSubmissions(formId?: string, fromDate?: Date, toDate?: Date, otpFilter?: string, utmFilter?: string) {
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
          select: { title: true }
        },
        edgeNode: {
          select: { title: true, host: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 100, // محدودیت پیش‌فرض، در صورت نیاز می‌توان صفحه‌بندی اضافه کرد
    });
  }

  private async enqueueFormUpsert(form: {
    id: string;
    title: string;
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
