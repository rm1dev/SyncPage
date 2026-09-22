import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { PrismaService } from '../../common/prisma/prisma.service';
import { formatJalaliDateTime } from '../../common/excel.util';
import { isEdge } from '../../config/role';
import { PaymentService } from './payment.service';
import { PaypingService } from './payping.service';
import { FormEngineService } from '../form-engine/form-engine.service';

@Controller()
export class PaymentVerifyController {
  private readonly logger = new Logger(PaymentVerifyController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    private readonly payping: PaypingService,
    private readonly forms: FormEngineService,
    private readonly config: ConfigService,
  ) {}

  @Get([':slug/verify', ':slug/verify/'])
  async handleVerifyGet(
    @Param('slug') slug: string,
    @Query() query: Record<string, string>,
    @Res() res: Response,
  ) {
    return this.processVerify(slug, query, {}, res);
  }

  @Post([':slug/verify', ':slug/verify/'])
  async handleVerifyPost(
    @Param('slug') slug: string,
    @Query() query: Record<string, string>,
    @Body() body: Record<string, string>,
    @Res() res: Response,
  ) {
    return this.processVerify(slug, query, body, res);
  }

  private async processVerify(
    slug: string,
    query: Record<string, string>,
    body: Record<string, string>,
    res: Response,
  ) {
    const refId = String(
      query.refid ||
        query.refId ||
        query.RefId ||
        body.refid ||
        body.refId ||
        body.RefId ||
        '',
    ).trim();

    const clientRefId = String(
      query.clientrefid ||
        query.clientRefId ||
        query.ClientRefId ||
        body.clientrefid ||
        body.clientRefId ||
        body.ClientRefId ||
        '',
    ).trim();

    const cardNumber = String(
      query.cardnumber ||
        query.cardNumber ||
        body.cardnumber ||
        body.cardNumber ||
        '',
    ).trim();

    const cardHashPan = String(
      query.cardhashpan ||
        query.cardHashPan ||
        body.cardhashpan ||
        body.cardHashPan ||
        '',
    ).trim();

    this.logger.log(
      `PayPing return for slug="${slug}", refId="${refId}", clientRefId="${clientRefId}"`,
    );

    // پیدا کردن فرم بر اساس اسلاگ
    const form = await this.prisma.form.findFirst({
      where: { slug },
      include: { formProducts: { include: { product: true } } },
    });

    // پیدا کردن رکورد پرداخت
    let payment = clientRefId
      ? await this.payments.getByClientRefId(clientRefId)
      : null;

    if (!payment && refId) {
      payment = await this.prisma.payment.findFirst({
        where: { refId },
        include: {
          form: true,
          product: true,
          submission: true,
        },
      });
    }

    if (!payment && form) {
      // در صورتی که clientRefId از سمت درگاه نرسیده باشد، آخرین پرداخت PENDING این فرم را جستجو می‌کنیم
      payment = await this.prisma.payment.findFirst({
        where: { formId: form.id, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        include: {
          form: true,
          product: true,
          submission: true,
        },
      });
    }

    let isSuccess = false;
    let isReversed = false;
    let errorMessage = '';
    const productTitle = payment?.product?.title || 'محصول';
    const amount = payment?.amount || 0;
    let finalRefId = refId || payment?.refId || '';
    let finalCardNumber = cardNumber || payment?.cardNumber || '';

    if (!payment) {
      errorMessage = 'اطلاعات تراکنش یافت نشد یا معتبر نیست';
    } else if (payment.status === 'COMPLETED') {
      // تراکنش قبلاً با موفقیت تایید شده (مثلاً رفرش صفحه توسط کاربر)
      isSuccess = true;
      finalRefId = payment.refId || finalRefId;
      finalCardNumber = payment.cardNumber || finalCardNumber;
    } else if (!refId) {
      // بازگشت از درگاه بدون کد پیگیری (انصراف یا خطا)
      errorMessage = 'پرداخت توسط کاربر لغو شد یا در درگاه انجام نپذیرفت';
      await this.payments.updatePayment(payment.id, {
        status: 'FAILED',
        errorMessage,
      });
    } else if (!payment.payCode) {
      errorMessage = 'کد پرداخت پی‌پینگ برای این تراکنش ثبت نشده است';
      await this.payments.updatePayment(payment.id, {
        status: 'FAILED',
        refId,
        cardNumber,
        cardHashPan,
        errorMessage,
      });
    } else {
      // پی‌پینگ برای وریفای به کد اولیه پرداخت نیاز دارد، نه RefID بازگشتی.
      const verifyResult = await this.payping.verifyPayment(
        payment.payCode,
        payment.amount,
      );

      if (verifyResult.success) {
        const verifiedAmount = verifyResult.amount ?? payment.amount;

        // کنترل تطابق دقیق مبلغ پرداخت شده با قیمت محصول
        if (verifiedAmount !== payment.amount) {
          this.logger.warn(
            `Amount mismatch for payment ${payment.id}: expected ${payment.amount}, received ${verifiedAmount}. Initiating reverse...`,
          );

          // ریورس خودکار در صورت عدم تطابق مبلغ
          await this.payping.reversePayment(refId, verifiedAmount);
          isReversed = true;
          errorMessage = `مبلغ پرداختی با مبلغ سفارش مغایرت داشت؛ وجه پرداختی بلافاصله برگشت داده شد (Reverse).`;

          await this.payments.updatePayment(payment.id, {
            status: 'REVERSED',
            refId,
            cardNumber: verifyResult.cardNumber || cardNumber,
            cardHashPan: verifyResult.cardHashPan || cardHashPan,
            errorMessage,
          });
        } else {
          // پرداخت کاملاً موفق و تایید شده
          isSuccess = true;
          finalRefId = refId;
          finalCardNumber = verifyResult.cardNumber || cardNumber;

          await this.forms.handlePaymentSuccess(
            payment.id,
            refId,
            finalCardNumber,
            verifyResult.cardHashPan || cardHashPan,
          );
        }
      } else {
        errorMessage =
          verifyResult.errorMessage || 'تراکنش توسط درگاه تایید نشد';
        await this.payments.updatePayment(payment.id, {
          status: 'FAILED',
          refId,
          cardNumber,
          cardHashPan,
          errorMessage,
        });
      }
    }

    const htmlContent = this.renderVerifyPage(slug, {
      isSuccess,
      isReversed,
      productTitle,
      amount,
      refId: finalRefId,
      cardNumber: finalCardNumber,
      errorMessage,
      date: new Date(),
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(htmlContent);
  }

  private renderVerifyPage(
    slug: string,
    data: {
      isSuccess: boolean;
      isReversed: boolean;
      productTitle: string;
      amount: number;
      refId: string;
      cardNumber: string;
      errorMessage: string;
      date: Date;
    },
  ): string {
    const staticPath =
      this.config.get<string>('staticPagesPath') || './static_pages';
    const absStaticPath = isAbsolute(staticPath)
      ? staticPath
      : join(process.cwd(), staticPath);
    const verifyHtmlPath = join(absStaticPath, slug, 'verify.html');

    const cardHtml = this.generateResultCardHtml(slug, data);

    if (existsSync(verifyHtmlPath)) {
      try {
        const rawHtml = readFileSync(verifyHtmlPath, 'utf8');
        // جستجوی المنت با شناسه content-section
        const contentSectionRegex =
          /(<([a-zA-Z0-9]+)[^>]*\bid=["']content-section["'][^>]*>)([\s\S]*?)(<\/\2>)/i;

        if (contentSectionRegex.test(rawHtml)) {
          return rawHtml.replace(contentSectionRegex, `$1\n${cardHtml}\n$4`);
        }

        // در صورت عدم وجود تگ دقیق، قبل از پایان body درج می‌کنیم
        if (rawHtml.includes('</body>')) {
          return rawHtml.replace('</body>', `${cardHtml}\n</body>`);
        }

        return `${rawHtml}\n${cardHtml}`;
      } catch (err) {
        this.logger.error(`Error reading ${verifyHtmlPath}:`, err);
      }
    }

    // تمپلیت پیش‌فرض کامل در صورتی که verify.html در پکیج لندینگ وجود نداشت
    return this.generateFullFallbackHtml(slug, cardHtml);
  }

  private generateResultCardHtml(
    slug: string,
    data: {
      isSuccess: boolean;
      isReversed: boolean;
      productTitle: string;
      amount: number;
      refId: string;
      cardNumber: string;
      errorMessage: string;
      date: Date;
    },
  ): string {
    const jalaliDateStr = formatJalaliDateTime(data.date);

    if (data.isSuccess) {
      return `
<div class="sp-payment-result sp-payment-success" style="font-family: inherit; direction: rtl; text-align: right; background: #ecfdf5; border: 1px solid #10b981; border-radius: 12px; padding: 2rem; max-width: 580px; margin: 2rem auto; box-shadow: 0 10px 25px -5px rgba(16, 185, 129, 0.1);">
  <div style="text-align: center; margin-bottom: 1.5rem;">
    <div style="width: 64px; height: 64px; background: #10b981; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 1rem;">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <h2 style="color: #065f46; margin: 0 0 0.5rem 0; font-size: 1.5rem; font-weight: 700;">پرداخت با موفقیت انجام شد</h2>
    <p style="color: #047857; margin: 0; font-size: 0.95rem;">سفارش شما با موفقیت ثبت و تایید گردید.</p>
  </div>
  
  <div style="background: #ffffff; border-radius: 8px; border: 1px solid #d1fae5; padding: 1.25rem; margin-bottom: 1.5rem;">
    <div style="display: flex; justify-content: space-between; padding: 0.6rem 0; border-bottom: 1px dashed #e5e7eb;">
      <span style="color: #6b7280; font-size: 0.9rem;">محصول سفارش داده شده:</span>
      <strong style="color: #111827; font-size: 0.95rem;">${this.escape(data.productTitle)}</strong>
    </div>
    <div style="display: flex; justify-content: space-between; padding: 0.6rem 0; border-bottom: 1px dashed #e5e7eb;">
      <span style="color: #6b7280; font-size: 0.9rem;">مبلغ پرداخت شده:</span>
      <strong style="color: #059669; font-size: 1.15rem;">${data.amount.toLocaleString('fa-IR')} تومان</strong>
    </div>
    <div style="display: flex; justify-content: space-between; padding: 0.6rem 0; border-bottom: 1px dashed #e5e7eb;">
      <span style="color: #6b7280; font-size: 0.9rem;">شماره پیگیری درگاه (RefID):</span>
      <code style="color: #1f2937; font-weight: 700; font-family: monospace; font-size: 1.05rem;">${this.escape(data.refId)}</code>
    </div>
    ${
      data.cardNumber
        ? `
    <div style="display: flex; justify-content: space-between; padding: 0.6rem 0; border-bottom: 1px dashed #e5e7eb;">
      <span style="color: #6b7280; font-size: 0.9rem;">شماره کارت پرداخت‌کننده:</span>
      <span style="color: #374151; direction: ltr; font-family: monospace; font-weight: 600;">${this.escape(data.cardNumber)}</span>
    </div>`
        : ''
    }
    <div style="display: flex; justify-content: space-between; padding: 0.6rem 0;">
      <span style="color: #6b7280; font-size: 0.9rem;">تاریخ و زمان پرداخت:</span>
      <span style="color: #374151; font-size: 0.9rem;">${jalaliDateStr}</span>
    </div>
  </div>

  <div style="text-align: center;">
    <a href="/${encodeURIComponent(slug)}/" style="display: inline-block; background: #10b981; color: #ffffff; text-decoration: none; padding: 0.75rem 2rem; border-radius: 8px; font-weight: 600; font-size: 0.95rem; transition: background 0.2s;">
      بازگشت به صفحه اصلی
    </a>
  </div>
</div>
`;
    }

    return `
<div class="sp-payment-result sp-payment-failed" style="font-family: inherit; direction: rtl; text-align: right; background: #fef2f2; border: 1px solid #ef4444; border-radius: 12px; padding: 2rem; max-width: 580px; margin: 2rem auto; box-shadow: 0 10px 25px -5px rgba(239, 68, 68, 0.1);">
  <div style="text-align: center; margin-bottom: 1.5rem;">
    <div style="width: 64px; height: 64px; background: #ef4444; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 1rem;">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </div>
    <h2 style="color: #991b1b; margin: 0 0 0.5rem 0; font-size: 1.5rem; font-weight: 700;">پرداخت ناموفق بود</h2>
    <p style="color: #b91c1c; margin: 0; font-size: 0.95rem; line-height: 1.5;">${this.escape(data.errorMessage || 'تراکنش انجام نشد یا توسط کاربر لغو گردید.')}</p>
  </div>
  
  <div style="background: #ffffff; border-radius: 8px; border: 1px solid #fee2e2; padding: 1.25rem; margin-bottom: 1.5rem;">
    ${
      data.refId
        ? `
    <div style="display: flex; justify-content: space-between; padding: 0.6rem 0; border-bottom: 1px dashed #e5e7eb;">
      <span style="color: #6b7280; font-size: 0.9rem;">کد پیگیری درگاه:</span>
      <code style="color: #1f2937; font-weight: 700; font-family: monospace;">${this.escape(data.refId)}</code>
    </div>`
        : ''
    }
    <div style="display: flex; justify-content: space-between; padding: 0.6rem 0;">
      <span style="color: #6b7280; font-size: 0.9rem;">وضعیت:</span>
      <span style="color: #dc2626; font-weight: 700;">${data.isReversed ? 'مغایرت مبلغ - برگشت داده شده (Reverse)' : 'ناموفق'}</span>
    </div>
  </div>

  <div style="text-align: center;">
    <a href="/${encodeURIComponent(slug)}/" style="display: inline-block; background: #ef4444; color: #ffffff; text-decoration: none; padding: 0.75rem 2rem; border-radius: 8px; font-weight: 600; font-size: 0.95rem;">
      بازگشت و تلاش مجدد
    </a>
  </div>
</div>
`;
  }

  private generateFullFallbackHtml(slug: string, cardHtml: string): string {
    return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>وضعیت پرداخت</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: #f3f4f6;
      color: #1f2937;
      margin: 0;
      padding: 2rem 1rem;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      box-sizing: border-box;
    }
    #content-section {
      width: 100%;
    }
  </style>
</head>
<body>
  <div id="content-section">
    ${cardHtml}
  </div>
</body>
</html>`;
  }

  private escape(str: string): string {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
