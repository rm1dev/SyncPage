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

  private buildWhere(filter: PaymentFilter): Prisma.PaymentWhereInput {
    const where: Prisma.PaymentWhereInput = {};

    if (filter.formId) where.formId = filter.formId;
    if (filter.productId) where.productId = filter.productId;
    if (filter.status) where.status = filter.status;
    if (filter.fromDate || filter.toDate) {
      where.createdAt = {};
      if (filter.fromDate) where.createdAt.gte = filter.fromDate;
      if (filter.toDate) where.createdAt.lte = filter.toDate;
    }

    return where;
  }

  private readonly listInclude = {
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
  } satisfies Prisma.PaymentInclude;

  async list(filter: PaymentFilter = {}) {
    return this.prisma.payment.findMany({
      where: this.buildWhere(filter),
      orderBy: { createdAt: 'desc' },
      include: this.listInclude,
    });
  }

  async listPaginated(
    filter: PaymentFilter,
    page: number,
    pageSize: number,
  ) {
    const where = this.buildWhere(filter);
    const [total, items, statusSummaries] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: this.listInclude,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.payment.groupBy({
        by: ['status'],
        where,
        orderBy: { status: 'asc' },
        _count: { id: true },
        _sum: { amount: true },
      }),
    ]);
    const summaryByStatus = new Map<
      PaymentStatus,
      { count: number; totalAmount: number }
    >(
      statusSummaries.map((summary) => {
        const aggregate = summary as {
          status: PaymentStatus;
          _count: { id: number | null };
          _sum: { amount: number | null };
        };
        return [
          aggregate.status,
          {
            count: aggregate._count.id || 0,
            totalAmount: aggregate._sum.amount || 0,
          },
        ];
      }),
    );

    return {
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
      stats: {
        completedCount:
          summaryByStatus.get(PaymentStatus.COMPLETED)?.count || 0,
        pendingCount: summaryByStatus.get(PaymentStatus.PENDING)?.count || 0,
        failedCount:
          (summaryByStatus.get(PaymentStatus.FAILED)?.count || 0) +
          (summaryByStatus.get(PaymentStatus.REVERSED)?.count || 0),
        totalCompletedAmount:
          summaryByStatus.get(PaymentStatus.COMPLETED)?.totalAmount || 0,
      },
    };
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
