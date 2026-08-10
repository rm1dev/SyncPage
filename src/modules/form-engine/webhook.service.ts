import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  async dispatch(form: {
    title: string;
    key: string;
    webhookUrl?: string | null;
    googleSheetUrl?: string | null;
    googleSheetMeta?: unknown;
    sendUtmToWebhook?: boolean;
    sendUtmToSheet?: boolean;
  }, submission: {
    id: string;
    payload: Record<string, unknown>;
    createdAt: Date;
  }) {
    let webhookFailed = false;
    let lastError = null;
    let attempts = 0;

    // 1. ارسال Webhook سفارشی در صورت تنظیم بودن
    if (form.webhookUrl) {
      const MAX_RETRIES = 3;
      let success = false;
      
      let webhookPayload = { ...submission.payload };
      if (form.sendUtmToWebhook === false) {
        Object.keys(webhookPayload).forEach(key => {
          if (key.startsWith('sp_utm_') || key.startsWith('utm_')) delete webhookPayload[key];
        });
      }
      
      while (attempts < MAX_RETRIES && !success) {
        attempts++;
        try {
          await this.sendWebhook(form.webhookUrl, {
            formKey: form.key,
            formTitle: form.title,
            submissionId: submission.id,
            payload: webhookPayload,
            createdAt: submission.createdAt.toISOString(),
          });
          success = true;
          this.logger.log(`Webhook sent successfully for submission ${submission.id} on attempt ${attempts}`);
        } catch (err: unknown) {
          lastError = err instanceof Error ? err.message : String(err);
          this.logger.error(`Webhook error for form ${form.key}, attempt ${attempts}: ${lastError}`);
          
          if (attempts < MAX_RETRIES) {
            // تاخیر افزایشی بین ریتراها: 1 دقیقه، 3 دقیقه
            const delayMs = attempts * 60 * 1000;
            this.logger.log(`Waiting ${delayMs}ms before next webhook retry...`);
            await new Promise(res => setTimeout(res, delayMs));
          } else {
            webhookFailed = true;
          }
        }
      }
    }

    // آپدیت وضعیت فرم در دیتابیس برای لیست خطادارها
    if (form.webhookUrl) {
      await this.prisma.formSubmission.update({
        where: { id: submission.id },
        data: {
          webhookStatus: webhookFailed ? 'FAILED' : 'SENT',
          webhookAttempts: attempts,
          webhookLastError: lastError,
        },
      }).catch(e => this.logger.error(`Failed to update submission webhook status: ${e.message}`));
    }

    // 2. ارسال به گوگل شیت در صورت تنظیم بودن (بدون تغییر)
    if (form.googleSheetUrl) {
      let sheetPayload = { ...submission.payload };
      if (form.sendUtmToSheet === false) {
        Object.keys(sheetPayload).forEach(key => {
          if (key.startsWith('sp_utm_') || key.startsWith('utm_')) delete sheetPayload[key];
        });
      }

      this.sendToGoogleSheet(
        form.googleSheetUrl,
        form.googleSheetMeta as { startRow?: number; columns?: Record<string, string> } | null,
        sheetPayload,
      ).catch((err) => {
        this.logger.error(`Google Sheet sync error for form ${form.key}: ${err.message}`);
      });
    }
  }

  async retryFailedWebhook(submissionId: string) {
    const submission = await this.prisma.formSubmission.findUnique({
      where: { id: submissionId },
      include: { form: true },
    });
    
    if (!submission || !submission.form.webhookUrl) {
      throw new Error('Submission or webhook config not found');
    }

    // آپدیت وضعیت به حالت PENDING تا مشخص شود در حال تلاش است
    await this.prisma.formSubmission.update({
      where: { id: submissionId },
      data: { webhookStatus: 'PENDING', webhookAttempts: { increment: 1 } },
    });

    try {
      let webhookPayload = { ...(submission.payload as Record<string, unknown>) };
      if (submission.form.sendUtmToWebhook === false) {
        Object.keys(webhookPayload).forEach(key => {
          if (key.startsWith('sp_utm_') || key.startsWith('utm_')) delete webhookPayload[key];
        });
      }

      await this.sendWebhook(submission.form.webhookUrl, {
        formKey: submission.form.key,
        formTitle: submission.form.title,
        submissionId: submission.id,
        payload: webhookPayload,
        createdAt: submission.createdAt.toISOString(),
      });

      await this.prisma.formSubmission.update({
        where: { id: submissionId },
        data: { webhookStatus: 'SENT', webhookLastError: null },
      });
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.formSubmission.update({
        where: { id: submissionId },
        data: { webhookStatus: 'FAILED', webhookLastError: message },
      });
      throw new Error(message);
    }
  }

  private async sendWebhook(templateUrl: string, data: Record<string, unknown>) {
    let resolvedUrl = templateUrl;
    const payload = (data.payload || {}) as Record<string, unknown>;

    // 1. جایگزینی متغیرهای داخل آدرس URL مانند $EMAIL$, $MOBILE$, {email}, $name$
    for (const [key, val] of Object.entries(payload)) {
      const encodedVal = encodeURIComponent(String(val ?? ''));
      // پشتیبانی از فرمت‌های مختلف مانند $FIELD$, $field$, {FIELD}, {field}
      const patterns = [
        new RegExp(`\\$${key}\\$`, 'gi'),
        new RegExp(`\\{${key}\\}`, 'gi'),
      ];
      for (const pattern of patterns) {
        resolvedUrl = resolvedUrl.replace(pattern, encodedVal);
      }
    }

    // پاک‌سازی placeholderهای باقی‌مانده که مقداری نداشتند (مثلا $SOMETHING$)
    resolvedUrl = resolvedUrl.replace(/\$[A-Za-z0-9_]+\$/g, '');
    resolvedUrl = resolvedUrl.replace(/\{[A-Za-z0-9_]+\}/g, '');

    // اضافه کردن خودکار پارامترهای UTM به Query String آدرس
    try {
      const urlObj = new URL(resolvedUrl);
      for (const [key, val] of Object.entries(payload)) {
        if (key.startsWith('utm_') || key.startsWith('sp_utm_')) {
          // برای جلوگیری از تکرار، فقط اگر از قبل تنظیم نشده بود اضافه می‌کنیم
          if (!urlObj.searchParams.has(key) && val !== undefined && val !== null && val !== '') {
            urlObj.searchParams.append(key, String(val));
          }
        }
      }
      resolvedUrl = urlObj.toString();
    } catch (e) {
      this.logger.warn(`Could not parse webhook URL to append UTMs: ${resolvedUrl}`);
    }

    this.logger.log(`Dispatching webhook to ${resolvedUrl}`);

    // اگر متغیر در Query String باشد می‌توان درخواست را با POST یا GET متناسب با نیاز ارسال کرد (اینجا POST با Payload کامل)
    await axios({
      method: 'POST',
      url: resolvedUrl,
      data,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SyncPage-Webhook/1.0',
      },
    });
  }

  private async sendToGoogleSheet(
    sheetUrl: string,
    meta: { startRow?: number; columns?: Record<string, string> } | null,
    payload: Record<string, unknown>,
  ) {
    this.logger.log(`Forwarding submission to Google Sheet endpoint: ${sheetUrl}`);
    
    // ارسال مستقیم دیتا همراه با متادیتا به وب‌هوک / Apps Script مربوط به شیت
    await axios.post(sheetUrl, {
      payload,
      meta: {
        startRow: meta?.startRow || 2,
        columns: meta?.columns || {},
      },
      submittedAt: new Date().toISOString(),
    }, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }
}
