import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OutboxService } from '../sync/outbox.service';
import { Prisma } from '@prisma/client';
import { IntegrationProfileDto } from './dto/integration-profile.dto';

@Injectable()
export class IntegrationProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async list() {
    return this.prisma.integrationProfile.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { forms: true } },
      },
    });
  }

  async getById(id: string) {
    const profile = await this.prisma.integrationProfile.findUnique({
      where: { id },
      include: {
        _count: { select: { forms: true } },
      },
    });
    if (!profile) throw new NotFoundException('Profile not found');
    return profile;
  }

  async create(dto: IntegrationProfileDto) {
    return this.prisma.integrationProfile.create({
      data: {
        name: dto.name,
        webhookUrl: dto.webhookUrl || null,
        googleSheetUrl: dto.googleSheetUrl || null,
        googleSheetMeta: dto.googleSheetMeta
          ? (dto.googleSheetMeta as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
  }

  async update(id: string, dto: IntegrationProfileDto) {
    const profile = await this.getById(id);

    const updatedProfile = await this.prisma.integrationProfile.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
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
      },
    });

    // قانون ویرایش: تمام فرم‌هایی که از این پروفایل استفاده کرده‌اند باید مقادیرشان آپدیت شود
    // و یک رکورد سینک برای آپدیت Edgeها ساخته شود
    const linkedForms = await this.prisma.form.findMany({
      where: { profileId: id },
    });
    if (linkedForms.length > 0) {
      await this.prisma.form.updateMany({
        where: { profileId: id },
        data: {
          webhookUrl: updatedProfile.webhookUrl,
          googleSheetUrl: updatedProfile.googleSheetUrl,
          googleSheetMeta: updatedProfile.googleSheetMeta ?? Prisma.JsonNull,
        },
      });

      // بازیابی مجدد فرم‌های آپدیت شده برای ارسال به Outbox
      const updatedForms = await this.prisma.form.findMany({
        where: { profileId: id },
        include: { category: true },
      });
      for (const form of updatedForms) {
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
          },
        });
      }
    }

    return updatedProfile;
  }

  async remove(id: string) {
    const profile = await this.getById(id);

    if (profile._count.forms > 0) {
      throw new BadRequestException(
        'این پروفایل در حال استفاده است و قابل حذف نیست. ابتدا آن را از فرم‌ها بردارید.',
      );
    }

    await this.prisma.integrationProfile.delete({ where: { id } });
    return { deleted: true };
  }
}
