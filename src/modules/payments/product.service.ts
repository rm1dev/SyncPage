import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isMaster } from '../../config/role';

@Injectable()
export class ProductService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.product.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { formProducts: true, payments: true } },
      },
    });
  }

  listWithFilter(q?: string) {
    const query = q?.trim();
    const where: Prisma.ProductWhereInput | undefined = query
      ? {
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } },
          ],
        }
      : undefined;

    return this.prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { formProducts: true, payments: true } },
      },
    });
  }

  async getById(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        _count: { select: { formProducts: true, payments: true } },
      },
    });
    if (!product) throw new NotFoundException('محصول یافت نشد');
    return product;
  }

  async create(data: {
    title: string;
    price: number;
    description?: string | null;
  }) {
    const product = await this.prisma.product.create({
      data: {
        title: data.title.trim(),
        price: Math.max(100, Math.floor(data.price)),
        description: data.description?.trim() || null,
      },
    });

    if (isMaster()) {
      await this.enqueueProductUpsert(product);
    }

    return product;
  }

  async update(
    id: string,
    data: {
      title?: string;
      price?: number;
      description?: string | null;
    },
  ) {
    await this.getById(id);
    const product = await this.prisma.product.update({
      where: { id },
      data: {
        ...(data.title !== undefined ? { title: data.title.trim() } : {}),
        ...(data.price !== undefined
          ? { price: Math.max(100, Math.floor(data.price)) }
          : {}),
        ...(data.description !== undefined
          ? { description: data.description?.trim() || null }
          : {}),
      },
    });

    if (isMaster()) {
      await this.enqueueProductUpsert(product);
    }

    return product;
  }

  async remove(id: string) {
    await this.getById(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.product.delete({ where: { id } });
      await tx.syncTombstone.create({
        data: { entityType: 'PRODUCT', entityKey: id },
      });
      if (isMaster()) {
        await tx.outboxEvent.create({
          data: {
            eventType: 'product.sync',
            idempotencyKey: `product:delete:${id}:${Date.now()}`,
            payload: { action: 'delete', id },
          },
        });
      }
    });

    return { deleted: true };
  }

  private async enqueueProductUpsert(product: {
    id: string;
    title: string;
    price: number;
    description: string | null;
  }) {
    await this.prisma.outboxEvent.create({
      data: {
        eventType: 'product.sync',
        idempotencyKey: `product:upsert:${product.id}:${Date.now()}`,
        payload: {
          action: 'upsert',
          id: product.id,
          product: {
            id: product.id,
            title: product.title,
            price: product.price,
            description: product.description,
          },
        },
      },
    });
  }
}
