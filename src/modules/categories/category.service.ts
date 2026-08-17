import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class CategoryService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.category.findMany({ orderBy: { name: 'asc' } });
  }

  async create(name: string) {
    const displayName = name?.trim();
    if (!displayName) {
      throw new BadRequestException('نام دسته بندی الزامی است');
    }

    const normalizedName = displayName.toLocaleLowerCase('fa-IR');
    const existing = await this.prisma.category.findUnique({
      where: { normalizedName },
    });
    if (existing) {
      throw new BadRequestException('این دسته بندی قبلا ایجاد شده است');
    }

    return this.prisma.category.create({
      data: { name: displayName, normalizedName },
    });
  }

  async update(id: string, name: string) {
    const displayName = name?.trim();
    if (!displayName) {
      throw new BadRequestException('نام دسته بندی الزامی است');
    }

    const category = await this.requireById(id);
    const normalizedName = displayName.toLocaleLowerCase('fa-IR');

    const existing = await this.prisma.category.findUnique({
      where: { normalizedName },
    });
    if (existing && existing.id !== id) {
      throw new BadRequestException('این نام دسته بندی قبلا ثبت شده است');
    }

    return this.prisma.category.update({
      where: { id },
      data: { name: displayName, normalizedName },
    });
  }

  async delete(id: string) {
    await this.requireById(id);

    return this.prisma.$transaction(async (tx) => {
      // Set categoryId to null for all linked forms and landings
      await tx.form.updateMany({
        where: { categoryId: id },
        data: { categoryId: null },
      });
      await tx.landing.updateMany({
        where: { categoryId: id },
        data: { categoryId: null },
      });
      return tx.category.delete({
        where: { id },
      });
    });
  }

  async idForName(name?: string | null): Promise<string | null> {
    const displayName = name?.trim();
    if (!displayName) return null;

    const normalizedName = displayName.toLocaleLowerCase('fa-IR');
    const category = await this.prisma.category.upsert({
      where: { normalizedName },
      create: { name: displayName, normalizedName },
      update: {},
    });
    return category.id;
  }

  async requireById(id?: string | null) {
    if (!id) return null;

    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) throw new NotFoundException('دسته بندی پیدا نشد');
    return category;
  }
}
