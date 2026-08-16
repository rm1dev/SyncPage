import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  async dispatch(
    form: {
      title: string;
      key: string;
      webhookUrl?: string | null;
      googleSheetUrl?: string | null;
      googleSheetMeta?: unknown;
      sendUtmToWebhook?: boolean;
      sendUtmToSheet?: boolean;
    },
    submission: {
      id: string;
      payload: Record<string, unknown>;
      createdAt: Date;
    },
  ) {
    let webhookFailed = false;
    let lastError: string | null = null;
    let attempts = 0;

    if (form.webhookUrl) {
      const maxRetries = 3;
      let success = false;
      const webhookPayload = this.withoutUtmWhenDisabled(
        submission.payload,
        form.sendUtmToWebhook,
      );
      const data = {
        formKey: form.key,
        formTitle: form.title,
        submissionId: submission.id,
        payload: webhookPayload,
        createdAt: submission.createdAt.toISOString(),
      };

      while (attempts < maxRetries && !success) {
        attempts++;
        try {
          const result = await this.sendWebhook(form.webhookUrl, data);
          await this.recordInvocation(submission.id, attempts, result);
          success = true;
          this.logger.log(
            `Webhook sent successfully for submission ${submission.id} on attempt ${attempts}`,
          );
        } catch (err: unknown) {
          const result = this.failedWebhookResult(form.webhookUrl, data, err);
          await this.recordInvocation(submission.id, attempts, result);
          lastError = result.error;
          this.logger.error(
            `Webhook error for form ${form.key}, attempt ${attempts}: ${lastError}`,
          );

          if (attempts < maxRetries) {
            const delayMs = attempts * 60 * 1000;
            this.logger.log(
              `Waiting ${delayMs}ms before next webhook retry...`,
            );
            await new Promise((res) => setTimeout(res, delayMs));
          } else {
            webhookFailed = true;
          }
        }
      }
    }

    if (form.webhookUrl) {
      await this.prisma.formSubmission
        .update({
          where: { id: submission.id },
          data: {
            webhookStatus: webhookFailed ? 'FAILED' : 'SENT',
            webhookAttempts: attempts,
            webhookLastError: lastError,
          },
        })
        .catch((e) =>
          this.logger.error(
            `Failed to update submission webhook status: ${e.message}`,
          ),
        );
    }

    if (form.googleSheetUrl) {
      const sheetPayload = this.withoutUtmWhenDisabled(
        submission.payload,
        form.sendUtmToSheet,
      );
      this.sendToGoogleSheet(
        form.googleSheetUrl,
        form.googleSheetMeta as {
          startRow?: number;
          columns?: Record<string, string>;
        } | null,
        sheetPayload,
      ).catch((err) => {
        this.logger.error(
          `Google Sheet sync error for form ${form.key}: ${err.message}`,
        );
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

    await this.prisma.formSubmission.update({
      where: { id: submissionId },
      data: { webhookStatus: 'PENDING', webhookAttempts: { increment: 1 } },
    });

    const data = {
      formKey: submission.form.key,
      formTitle: submission.form.title,
      submissionId: submission.id,
      payload: this.withoutUtmWhenDisabled(
        submission.payload as Record<string, unknown>,
        submission.form.sendUtmToWebhook,
      ),
      createdAt: submission.createdAt.toISOString(),
    };
    const attempt = submission.webhookAttempts + 1;

    try {
      const result = await this.sendWebhook(submission.form.webhookUrl, data);
      await this.recordInvocation(submissionId, attempt, result);
      await this.prisma.formSubmission.update({
        where: { id: submissionId },
        data: { webhookStatus: 'SENT', webhookLastError: null },
      });
      return { success: true };
    } catch (err: unknown) {
      const result = this.failedWebhookResult(
        submission.form.webhookUrl,
        data,
        err,
      );
      await this.recordInvocation(submissionId, attempt, result);
      await this.prisma.formSubmission.update({
        where: { id: submissionId },
        data: { webhookStatus: 'FAILED', webhookLastError: result.error },
      });
      throw new Error(result.error || 'Webhook request failed');
    }
  }

  private withoutUtmWhenDisabled(
    payload: Record<string, unknown>,
    sendUtm: boolean | undefined,
  ) {
    const result = { ...payload };
    if (sendUtm === false) {
      Object.keys(result).forEach((key) => {
        if (key.startsWith('sp_utm_') || key.startsWith('utm_')) {
          delete result[key];
        }
      });
    }
    return result;
  }

  private async sendWebhook(
    templateUrl: string,
    data: Record<string, unknown>,
  ) {
    const resolvedUrl = this.resolveWebhookUrl(templateUrl, data);
    const startedAt = Date.now();
    const response = await axios({
      method: 'POST',
      url: resolvedUrl,
      data,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SyncPage-Webhook/1.0',
      },
    });

    return {
      requestUrl: resolvedUrl,
      success: true,
      responseStatus: response.status,
      responseBody: this.serializeBody(response.data),
      responseHeaders: this.safeHeaders(response.headers),
      error: null,
      durationMs: Date.now() - startedAt,
    };
  }

  private failedWebhookResult(
    templateUrl: string,
    data: Record<string, unknown>,
    err: unknown,
  ) {
    const axiosError = axios.isAxiosError(err) ? (err as AxiosError) : null;
    const response = axiosError?.response;
    const message = err instanceof Error ? err.message : String(err);
    return {
      requestUrl: this.resolveWebhookUrl(templateUrl, data),
      success: false,
      responseStatus: response?.status || null,
      responseBody: response ? this.serializeBody(response.data) : null,
      responseHeaders: response ? this.safeHeaders(response.headers) : null,
      error: message,
      durationMs: null,
    };
  }

  private async recordInvocation(
    submissionId: string,
    attempt: number,
    result: {
      requestUrl: string;
      success: boolean;
      responseStatus: number | null;
      responseBody: string | null;
      responseHeaders: Record<string, string> | null;
      error: string | null;
      durationMs: number | null;
    },
  ) {
    await this.prisma.webhookInvocation
      .create({
        data: {
          submissionId,
          attempt,
          requestUrl: result.requestUrl,
          success: result.success,
          responseStatus: result.responseStatus,
          responseBody: result.responseBody,
          responseHeaders: result.responseHeaders
            ? (result.responseHeaders as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          error: result.error,
          durationMs: result.durationMs,
        },
      })
      .catch((error) =>
        this.logger.error(
          `Failed to record webhook invocation: ${error.message}`,
        ),
      );
  }

  private resolveWebhookUrl(
    templateUrl: string,
    data: Record<string, unknown>,
  ) {
    let resolvedUrl = templateUrl;
    const payload = (data.payload || {}) as Record<string, unknown>;

    for (const [key, val] of Object.entries(payload)) {
      const encodedVal = encodeURIComponent(String(val ?? ''));
      for (const pattern of [
        new RegExp(`\\$${key}\\$`, 'gi'),
        new RegExp(`\\{${key}\\}`, 'gi'),
      ]) {
        resolvedUrl = resolvedUrl.replace(pattern, encodedVal);
      }
    }

    resolvedUrl = resolvedUrl.replace(/\$[A-Za-z0-9_]+\$/g, '');
    resolvedUrl = resolvedUrl.replace(/\{[A-Za-z0-9_]+\}/g, '');

    try {
      const urlObj = new URL(resolvedUrl);
      for (const [key, val] of Object.entries(payload)) {
        if (
          (key.startsWith('utm_') || key.startsWith('sp_utm_')) &&
          !urlObj.searchParams.has(key) &&
          val !== undefined &&
          val !== null &&
          val !== ''
        ) {
          urlObj.searchParams.append(key, String(val));
        }
      }
      resolvedUrl = urlObj.toString();
    } catch {
      this.logger.warn(
        `Could not parse webhook URL to append UTMs: ${resolvedUrl}`,
      );
    }

    this.logger.log(`Dispatching webhook to ${resolvedUrl}`);
    return resolvedUrl;
  }

  private serializeBody(value: unknown) {
    if (value === undefined || value === null) return null;
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    return body.length > 10_000
      ? `${body.slice(0, 10_000)}\n[truncated]`
      : body;
  }

  private safeHeaders(headers: unknown): Record<string, string> {
    const hidden = new Set([
      'authorization',
      'cookie',
      'set-cookie',
      'proxy-authorization',
    ]);
    return Object.fromEntries(
      Object.entries((headers || {}) as Record<string, unknown>)
        .filter(([key]) => !hidden.has(key.toLowerCase()))
        .map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(', ') : String(value),
        ]),
    );
  }

  private async sendToGoogleSheet(
    sheetUrl: string,
    meta: { startRow?: number; columns?: Record<string, string> } | null,
    payload: Record<string, unknown>,
  ) {
    this.logger.log(
      `Forwarding submission to Google Sheet endpoint: ${sheetUrl}`,
    );
    await axios.post(
      sheetUrl,
      {
        payload,
        meta: { startRow: meta?.startRow || 2, columns: meta?.columns || {} },
        submittedAt: new Date().toISOString(),
      },
      { timeout: 15000, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
