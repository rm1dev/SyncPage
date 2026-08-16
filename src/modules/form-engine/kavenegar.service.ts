import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class KavenegarService {
  private readonly logger = new Logger(KavenegarService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getApiKey(): Promise<string | null> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: 'KAVENEGAR_API_KEY' },
    });
    return setting?.value || process.env.KAVENEGAR_API_KEY || null;
  }

  async setApiKey(key: string): Promise<void> {
    await this.prisma.systemSetting.upsert({
      where: { key: 'KAVENEGAR_API_KEY' },
      create: { key: 'KAVENEGAR_API_KEY', value: key.trim() },
      update: { value: key.trim() },
    });

    // صف کردن رویداد همگام‌سازی تنظیمات برای Edgeها
    if (process.env.NODE_ROLE !== 'EDGE') {
      try {
        const { OutboxService } = await import('../sync/outbox.service');
        // Instantiating OutboxService dynamically is tough due to dependencies.
        // Prisma raw query will fail to insert to outbox table if not properly structured.
        // We will insert outbox record directly through prisma instead of importing service.
        await this.prisma.outboxEvent.create({
          data: {
            eventType: 'setting.sync',
            idempotencyKey: `setting:KAVENEGAR_API_KEY:${Date.now()}`,
            payload: {
              key: 'KAVENEGAR_API_KEY',
              value: key.trim(),
            },
          },
        });
      } catch (err) {
        this.logger.error('Failed to enqueue setting sync', err);
      }
    }
  }

  /**
   * ارسال OTP با استفاده از متد Lookup کاوه‌نگار
   * https://api.kavenegar.com/v1/{API-KEY}/verify/lookup.json
   */
  async sendLookupOtp(
    receptor: string,
    token: string,
    template: string,
  ): Promise<boolean> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      this.logger.warn(
        'Kavenegar API Key is not configured. OTP SMS cannot be sent.',
      );
      return false;
    }

    try {
      const cleanReceptor = receptor.trim();
      const url = `https://api.kavenegar.com/v1/${apiKey}/verify/lookup.json`;

      const response = await axios.get(url, {
        params: {
          receptor: cleanReceptor,
          token: token.trim(),
          template: template.trim(),
        },
        timeout: 10000,
      });

      if (
        response.data &&
        response.data.return &&
        response.data.return.status === 200
      ) {
        this.logger.log(
          `OTP SMS sent to ${cleanReceptor} via template ${template}`,
        );
        return true;
      } else {
        this.logger.error(
          `Kavenegar API error: ${JSON.stringify(response.data)}`,
        );
        return false;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send OTP via Kavenegar: ${msg}`);
      return false;
    }
  }
}
