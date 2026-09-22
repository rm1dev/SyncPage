import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  createExcelWorkbook,
  formatJalaliDateTime,
} from '../../common/excel.util';

export interface PaymentFilter {
  formId?: string;
  productId?: string;
  status?: PaymentStatus;
  fromDate?: Date;
  toDate?: Date;
}

@Injectable()
export class PaymentService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filter: PaymentFilter = {}) {
    const where: Prisma.PaymentWhereInput = {};

    if (filter.formId) {
      where.formId = filter.formId;
    }
    if (filter.productId) {
      where.productId = filter.productId;
    }
    if (filter.status) {
      where.status = filter.status;
    }
    if (filter.fromDate || filter.toDate) {
      where.createdAt = {};
      if (filter.fromDate) {
        where.createdAt.gte = filter.fromDate;
      }
      if (filter.toDate) {
        where.createdAt.lte = filter.toDate;
      }
    }

    return this.prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        form: { select: { id: true, title: true, key: true, slug: true } },
        product: { select: { id: true, title: true, price: true } },
        submission: {
          select: {
            id: true,
            payload: true,
            createdAt: true,
            otpStatus: true,
          },
        },
        edgeNode: { select: { id: true, title: true } },
      },
    });
  }

  async getById(id: string) {
    return this.prisma.payment.findUnique({
      where: { id },
      include: {
        form: true,
        product: true,
        submission: true,
        edgeNode: true,
      },
    });
  }

  async getBySubmissionId(submissionId: string) {
    return this.prisma.payment.findUnique({
      where: { submissionId },
      include: {
        form: true,
        product: true,
        submission: true,
      },
    });
  }

  async getByClientRefId(clientRefId: string) {
    return this.prisma.payment.findFirst({
      where: { clientRefId },
      include: {
        form: true,
        product: true,
        submission: true,
      },
    });
  }

  async createPayment(data: {
    submissionId: string;
    formId: string;
    productId: string;
    edgeNodeId?: string | null;
    amount: number;
    payCode?: string | null;
    clientRefId?: string | null;
  }) {
    return this.prisma.payment.create({
      data: {
        submissionId: data.submissionId,
        formId: data.formId,
        productId: data.productId,
        edgeNodeId: data.edgeNodeId || null,
        amount: data.amount,
        payCode: data.payCode || null,
        clientRefId: data.clientRefId || null,
        status: PaymentStatus.PENDING,
      },
      include: {
        product: true,
        form: true,
      },
    });
  }

  async updatePayment(
    id: string,
    data: {
      status?: PaymentStatus;
      refId?: string | null;
      payCode?: string | null;
      cardNumber?: string | null;
      cardHashPan?: string | null;
      errorMessage?: string | null;
      verifiedAt?: Date | null;
    },
  ) {
    return this.prisma.payment.update({
      where: { id },
      data,
      include: {
        product: true,
        form: true,
        submission: true,
      },
    });
  }

  async exportExcel(payments: Awaited<ReturnType<PaymentService['list']>>) {
    const columns = [
      { header: 'شناسه پرداخت', key: 'id', width: 36 },
      { header: 'عنوان فرم', key: 'formTitle', width: 22 },
      { header: 'نام محصول', key: 'productTitle', width: 22 },
      { header: 'مبلغ (تومان)', key: 'amount', width: 16 },
      { header: 'وضعیت پرداخت', key: 'status', width: 16 },
      { header: 'کد پیگیری (RefID)', key: 'refId', width: 20 },
      { header: 'شماره کارت', key: 'cardNumber', width: 20 },
      { header: 'نود ثبت‌کننده', key: 'nodeTitle', width: 20 },
      { header: 'تاریخ ثبت (جلالی)', key: 'createdAt', width: 22 },
      { header: 'تاریخ تایید (جلالی)', key: 'verifiedAt', width: 22 },
      { header: 'خطای احتمالی', key: 'errorMessage', width: 30 },
    ];

    const statusMap: Record<PaymentStatus, string> = {
      PENDING: 'در انتظار پرداخت',
      COMPLETED: 'موفق',
      FAILED: 'ناموفق',
      REVERSED: 'برگشت خورده (Reverse)',
    };

    const rows = payments.map((p) => ({
      id: p.id,
      formTitle: p.form?.title || '—',
      productTitle: p.product?.title || '—',
      amount: p.amount.toLocaleString('fa-IR'),
      status: statusMap[p.status] || p.status,
      refId: p.refId || '—',
      cardNumber: p.cardNumber || '—',
      nodeTitle: p.edgeNode?.title || 'سرور Master',
      createdAt: formatJalaliDateTime(p.createdAt),
      verifiedAt: p.verifiedAt ? formatJalaliDateTime(p.verifiedAt) : '—',
      errorMessage: p.errorMessage || '—',
    }));

    return createExcelWorkbook('لیست پرداخت‌ها', columns, rows);
  }
}
