import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface CreatePaypingPaymentDto {
  amount: number; // مبلغ به تومان
  returnUrl: string;
  clientRefId?: string;
  isReversible?: boolean;
  payerIdentity?: string;
  payerName?: string;
  description?: string;
}

export interface PaypingVerifyResult {
  success: boolean;
  amount?: number;
  clientRefId?: string;
  paymentRefId?: number;
  cardNumber?: string;
  cardHashPan?: string;
  errorMessage?: string;
}

export interface PaypingReverseResult {
  success: boolean;
  errorMessage?: string;
}

@Injectable()
export class PaypingService {
  private readonly logger = new Logger(PaypingService.name);
  private readonly baseUrl = 'https://api.payping.ir';

  constructor(private readonly prisma: PrismaService) {}

  async getApiToken(): Promise<string | null> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: 'PAYPING_API_TOKEN' },
    });
    return setting?.value || process.env.PAYPING_API_TOKEN || null;
  }

  async setApiToken(token: string): Promise<void> {
    const cleanToken = token.trim();
    await this.prisma.systemSetting.upsert({
      where: { key: 'PAYPING_API_TOKEN' },
      create: { key: 'PAYPING_API_TOKEN', value: cleanToken },
      update: { value: cleanToken },
    });

    if (process.env.NODE_ROLE !== 'EDGE') {
      try {
        await this.prisma.outboxEvent.create({
          data: {
            eventType: 'setting.sync',
            idempotencyKey: `setting:PAYPING_API_TOKEN:${Date.now()}`,
            payload: {
              key: 'PAYPING_API_TOKEN',
              value: cleanToken,
            },
          },
        });
      } catch (err) {
        this.logger.error(
          'Failed to enqueue PAYPING_API_TOKEN setting sync',
          err,
        );
      }
    }
  }

  async createPayment(
    dto: CreatePaypingPaymentDto,
    tokenOverride?: string,
  ): Promise<{ code: string; paymentUrl: string }> {
    const token = tokenOverride?.trim() || (await this.getApiToken());
    if (!token) {
      throw new Error(
        'کلید دسترسی درگاه پی‌پینگ (PAYPING_API_TOKEN) در تنظیمات سیستم وارد نشده است',
      );
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/v3/pay`,
        {
          amount: dto.amount,
          returnUrl: dto.returnUrl,
          clientRefId: dto.clientRefId,
          isReversible: dto.isReversible ?? false,
          payerIdentity: dto.payerIdentity,
          payerName: dto.payerName,
          description: dto.description || 'پرداخت آنلاین فرم',
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 15000,
        },
      );

      const code: unknown = response.data?.paymentCode;
      const paymentUrl: unknown = response.data?.url;
      if (
        typeof code !== 'string' ||
        !code.trim() ||
        typeof paymentUrl !== 'string' ||
        !paymentUrl.trim() ||
        !this.isPaypingPaymentUrl(paymentUrl)
      ) {
        throw new Error('کد یا لینک پرداخت معتبر از پی‌پینگ دریافت نشد');
      }

      return { code, paymentUrl };
    } catch (err) {
      const msg = this.extractErrorMessage(
        err,
        'خطا در اتصال به درگاه پی‌پینگ',
      );
      this.logger.error(`PayPing create payment failed: ${msg}`);
      throw new Error(msg);
    }
  }

  async verifyPayment(
    paymentRefId: string,
    paymentCode: string,
    amount: number,
  ): Promise<PaypingVerifyResult> {
    const token = await this.getApiToken();
    if (!token) {
      return {
        success: false,
        errorMessage: 'کلید درگاه پی‌پینگ تنظیم نشده است',
      };
    }
    if (
      !paymentRefId?.trim() ||
      !paymentCode?.trim() ||
      !/^\d+$/.test(paymentRefId)
    ) {
      return {
        success: false,
        errorMessage:
          'کد رهگیری یا کد پرداخت پی‌پینگ برای تایید تراکنش معتبر نیست',
      };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/v3/pay/verify`,
        {
          paymentRefId: Number(paymentRefId),
          paymentCode,
          amount,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 15000,
        },
      );

      return {
        success: true,
        amount: response.data?.amount,
        clientRefId: response.data?.clientRefId,
        paymentRefId: response.data?.paymentRefId,
        cardNumber: response.data?.cardNumber,
        cardHashPan: response.data?.cardHashPan,
      };
    } catch (err) {
      const msg = this.extractErrorMessage(err, 'تراکنش توسط درگاه تایید نشد');
      this.logger.warn(
        `PayPing verify failed for paymentRefId=${paymentRefId}: ${msg}`,
      );
      return {
        success: false,
        errorMessage: msg,
      };
    }
  }

  async reversePayment(
    paymentRefId: string,
    paymentCode: string,
  ): Promise<PaypingReverseResult> {
    const token = await this.getApiToken();
    if (!token) {
      return {
        success: false,
        errorMessage: 'کلید درگاه پی‌پینگ تنظیم نشده است',
      };
    }

    try {
      await axios.post(
        `${this.baseUrl}/v3/pay/reverse`,
        {
          paymentRefId: Number(paymentRefId),
          paymentCode,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 15000,
        },
      );

      return { success: true };
    } catch (err) {
      const msg = this.extractErrorMessage(
        err,
        'خطا در بازگشت وجه تراکنش (Reverse)',
      );
      this.logger.error(
        `PayPing reverse failed for paymentRefId=${paymentRefId}: ${msg}`,
      );
      return { success: false, errorMessage: msg };
    }
  }

  private isPaypingPaymentUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        (url.hostname === 'payping.ir' || url.hostname.endsWith('.payping.ir'))
      );
    } catch {
      return false;
    }
  }

  private extractErrorMessage(err: unknown, fallback: string): string {
    if (axios.isAxiosError(err)) {
      const data = err.response?.data;
      if (typeof data === 'string') return data;
      if (data && typeof data === 'object') {
        const values = Object.values(data);
        if (values.length > 0) {
          return values
            .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
            .join(' - ');
        }
      }
      if (err.message) return err.message;
    } else if (err instanceof Error) {
      return err.message;
    }
    return fallback;
  }
}
