import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isEdge, isMaster } from '../../config/role';
import { OutboxService } from '../sync/outbox.service';
import { CreateFormDto, UpdateFormDto } from './dto/form.dto';

@Injectable()
export class FormEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
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

  async submit(key: string, payload: Record<string, unknown>) {
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

    // اول روی همین گره ذخیره می‌شه (Edge برای سرعت/در دسترس بودن)
    const submission = await this.prisma.formSubmission.create({
      data: {
        formId: form.id,
        payload: payload as Prisma.InputJsonValue,
      },
    });

    // از Edge به Master همگام می‌کنیم؛ روی Master نیازی به outbox نیست
    if (isEdge()) {
      await this.outbox.enqueueFormSubmission({
        idempotencyKey: `submission:${submission.id}`,
        submissionId: submission.id,
        formKey: form.key,
        payload,
        createdAt: submission.createdAt.toISOString(),
      });
    }

    return submission;
  }

  listSubmissions(formId: string) {
    return this.prisma.formSubmission.findMany({
      where: { formId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  private async enqueueFormUpsert(form: {
    id: string;
    title: string;
    key: string;
    slug: string;
    body: unknown;
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
      },
    });
  }
}
