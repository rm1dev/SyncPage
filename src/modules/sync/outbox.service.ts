import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxStatus, Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';
import { PrismaService } from '../../common/prisma/prisma.service';
import { getNodeRole } from '../../config/role';
import {
  FormSubmissionSyncPayload,
  FormSyncPayload,
  LandingSyncPayload,
} from './sync.types';

type OutboxPayload =
  | LandingSyncPayload
  | FormSyncPayload
  | FormSubmissionSyncPayload;

export type RabbitHealthStatus = {
  ok: boolean;
  queue: string;
  error?: string;
};

@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private timer: NodeJS.Timeout | null = null;
  private publishing = false;
  private connecting = false;
  private destroyed = false;
  private lastConnectError: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    // هم Master هم Edge outbox دارن (جهت‌های متفاوت)
    void this.startWorker();
  }

  private async startWorker() {
    await this.connectWithRetry();
    const pollMs = this.config.get<number>('outboxPollMs') || 3000;
    this.timer = setInterval(() => {
      void this.flush();
    }, pollMs);
    this.logger.log(
      `Outbox worker started as ${getNodeRole()} (poll ${pollMs}ms)`,
    );
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      /* ignore */
    }
  }

  /** وضعیت اتصال Outbox به RabbitMQ — برای /api/health و تایید نود */
  async getRabbitStatus(): Promise<RabbitHealthStatus> {
    const queue = this.edgeQueue();
    if (!this.channel || !this.connection) {
      const error = this.connecting
        ? this.lastConnectError || 'RabbitMQ connecting…'
        : this.lastConnectError || 'RabbitMQ not connected';
      return { ok: false, queue, error };
    }
    try {
      await this.channel.checkQueue(queue);
      return { ok: true, queue };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastConnectError = message;
      return { ok: false, queue, error: message };
    }
  }

  private async connectWithRetry(attempt = 1): Promise<void> {
    if (this.destroyed || this.connecting) return;
    this.connecting = true;
    try {
      await this.connect();
      this.connecting = false;
    } catch (err) {
      this.connecting = false;
      if (this.destroyed) return;
      const message = err instanceof Error ? err.message : String(err);
      this.lastConnectError = message;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
      this.logger.error(
        `RabbitMQ connect failed (attempt ${attempt}): ${message}. Retry in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
      return this.connectWithRetry(attempt + 1);
    }
  }

  private edgeQueue() {
    return this.config.get<string>('rabbitmqQueue') || 'landing.sync';
  }

  private masterQueue() {
    return (
      this.config.get<string>('rabbitmqMasterQueue') || 'form.submission'
    );
  }

  private clearConnection(reason: string) {
    this.channel = null;
    this.connection = null;
    this.lastConnectError = reason;
  }

  /** timeout اتصال — مسیر بین‌الملل گاهی کند است ولی بدون سقف برای همیشه هنگ می‌کنه */
  private connectTimeoutMs() {
    const raw = process.env.RABBITMQ_CONNECT_TIMEOUT_MS;
    const n = raw ? parseInt(raw, 10) : 45_000;
    return Number.isFinite(n) && n > 0 ? n : 45_000;
  }

  private redactAmqpUrl(url: string) {
    return url.replace(/:[^:@/]+@/, ':***@');
  }

  /** heartbeat رو توی query استرینگ URL می‌ذاریم (amqplib v2 دیگه توی socketOptions قبول نمی‌کنه) */
  private withHeartbeat(url: string, heartbeat: number): string {
    try {
      const u = new URL(url);
      u.searchParams.set('heartbeat', String(heartbeat));
      return u.toString();
    } catch {
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}heartbeat=${heartbeat}`;
    }
  }

  /** heartbeat ثانیه — مسیر بین‌الملل با ۳۰s مدام missed heartbeats می‌خوره */
  private heartbeatSeconds() {
    const raw = process.env.RABBITMQ_HEARTBEAT;
    if (raw === '0' || raw === 'off') return 0;
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    // Edge ریموت: heartbeat خیلی بلند (یا ۰=خاموش) تا لینک شل قطع نشه
    return getNodeRole() === 'EDGE' ? 600 : 60;
  }

  private async connect() {
    const url = this.config.get<string>('rabbitmqUrl')!;
    const timeoutMs = this.connectTimeoutMs();
    const heartbeat = this.heartbeatSeconds();
    const connectUrl = this.withHeartbeat(url, heartbeat);
    this.lastConnectError = `Connecting to ${this.redactAmqpUrl(connectUrl)} (timeout ${timeoutMs}ms, heartbeat ${heartbeat}s)…`;
    this.logger.log(this.lastConnectError);

    // اگه handshake وسط راه گیر کنه (TCP باز ولی AMQP فیلتر)، بدون سقف تا ابد می‌مونه
    const pending = amqp.connect(connectUrl);
    let won: 'ok' | 'timeout' | null = null;
    const connection = await Promise.race([
      pending.then((c) => {
        won = 'ok';
        return c;
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          if (won === 'ok') return;
          won = 'timeout';
          void pending.then((c) => c.close()).catch(() => undefined);
          reject(
            new Error(
              `RabbitMQ connect timeout after ${timeoutMs}ms (${this.redactAmqpUrl(connectUrl)})`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
    const channel = await connection.createChannel();

    connection.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.lastConnectError = message;
      this.logger.error(`RabbitMQ connection error: ${message}`);
    });
    connection.on('close', () => {
      this.clearConnection(
        this.lastConnectError || 'RabbitMQ connection closed',
      );
      this.logger.warn('RabbitMQ connection closed — will retry');
      if (!this.destroyed) void this.connectWithRetry();
    });

    const edgeQueue = this.edgeQueue();
    const masterQueue = this.masterQueue();

    await channel.assertQueue(edgeQueue, { durable: true });
    await channel.assertQueue(masterQueue, { durable: true });
    await channel.assertExchange('landing.exchange', 'topic', {
      durable: true,
    });
    await channel.bindQueue(edgeQueue, 'landing.exchange', 'landing.sync');
    await channel.bindQueue(edgeQueue, 'landing.exchange', 'form.sync');
    await channel.bindQueue(
      masterQueue,
      'landing.exchange',
      'form.submission.sync',
    );

    // صف‌های per-node رو هم assert می‌کنیم
    const nodeQueues = await this.listNodeQueues();
    for (const q of nodeQueues) {
      await channel.assertQueue(q, { durable: true });
      await channel.bindQueue(q, 'landing.exchange', 'landing.sync');
      await channel.bindQueue(q, 'landing.exchange', 'form.sync');
    }

    this.connection = connection;
    this.channel = channel;
    this.lastConnectError = null;

    this.logger.log(
      `Outbox connected to RabbitMQ (node queues: ${nodeQueues.length}, heartbeat ${heartbeat}s)`,
    );
  }

  /** صف‌های اختصاصی نودهای ثبت‌شده در پنل */
  private async listNodeQueues(): Promise<string[]> {
    try {
      const nodes = await this.prisma.edgeNode.findMany({
        select: { queueName: true },
      });
      return nodes.map((n) => n.queueName);
    } catch {
      // اگه مایگریشن هنوز نخورده باشه، فقط صف پیش‌فرض
      return [];
    }
  }

  /**
   * برای landing/form.sync: به همه نودها بفرست
   * اگه نودی ثبت نشده، همون صف پیش‌فرض (محلی/سازگاری)
   */
  private async queuesForEvent(eventType: string): Promise<string[]> {
    if (eventType === 'form.submission.sync') return [this.masterQueue()];

    const nodeQueues = await this.listNodeQueues();
    if (nodeQueues.length > 0) return nodeQueues;
    return [this.edgeQueue()];
  }

  async flush() {
    if (this.publishing) return;
    this.publishing = true;
    try {
      if (!this.channel) await this.connect();
      const maxAttempts = this.config.get<number>('outboxMaxAttempts') || 10;
      const role = getNodeRole();

      // هر نقش فقط eventهای مربوط به خودش رو publish می‌کنه
      const eventTypes =
        role === 'MASTER'
          ? ['landing.sync', 'form.sync']
          : ['form.submission.sync'];

      const batch = await this.prisma.outboxEvent.findMany({
        where: {
          eventType: { in: eventTypes },
          status: { in: [OutboxStatus.PENDING, OutboxStatus.FAILED] },
          attempts: { lt: maxAttempts },
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });

      for (const event of batch) {
        try {
          const payload = event.payload as unknown as OutboxPayload;
          const queues = await this.queuesForEvent(event.eventType);

          const nestMessage = {
            pattern: event.eventType,
            data: payload,
          };
          const body = Buffer.from(JSON.stringify(nestMessage));

          for (const queue of queues) {
            await this.channel!.assertQueue(queue, { durable: true });
            const ok = this.channel!.sendToQueue(queue, body, {
              persistent: true,
              contentType: 'application/json',
              messageId: event.idempotencyKey,
              headers: { eventType: event.eventType },
            });
            if (!ok) {
              throw new Error(`RabbitMQ publish buffer full (${queue})`);
            }
          }

          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: OutboxStatus.SENT,
              attempts: { increment: 1 },
              lastError: null,
            },
          });
          this.logger.log(
            `Outbox sent: ${event.idempotencyKey} → [${queues.join(', ')}]`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`Outbox publish failed: ${message}`);
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: OutboxStatus.FAILED,
              attempts: { increment: 1 },
              lastError: message,
            },
          });
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    } finally {
      this.publishing = false;
    }
  }

  async enqueueLanding(payload: LandingSyncPayload) {
    return this.prisma.outboxEvent.create({
      data: {
        eventType: 'landing.sync',
        idempotencyKey: payload.idempotencyKey,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async enqueueFormSync(payload: FormSyncPayload) {
    return this.prisma.outboxEvent.create({
      data: {
        eventType: 'form.sync',
        idempotencyKey: payload.idempotencyKey,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async enqueueFormSubmission(payload: FormSubmissionSyncPayload) {
    return this.prisma.outboxEvent.create({
      data: {
        eventType: 'form.submission.sync',
        idempotencyKey: payload.idempotencyKey,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
