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

@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private timer: NodeJS.Timeout | null = null;
  private publishing = false;

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
    if (this.timer) clearInterval(this.timer);
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      /* ignore */
    }
  }

  private async connectWithRetry(attempt = 1): Promise<void> {
    try {
      await this.connect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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

  private async connect() {
    const url = this.config.get<string>('rabbitmqUrl')!;
    this.connection = await amqp.connect(url);
    this.channel = await this.connection.createChannel();

    const edgeQueue = this.edgeQueue();
    const masterQueue = this.masterQueue();

    await this.channel.assertQueue(edgeQueue, { durable: true });
    await this.channel.assertQueue(masterQueue, { durable: true });
    await this.channel.assertExchange('landing.exchange', 'topic', {
      durable: true,
    });
    await this.channel.bindQueue(edgeQueue, 'landing.exchange', 'landing.sync');
    await this.channel.bindQueue(edgeQueue, 'landing.exchange', 'form.sync');
    await this.channel.bindQueue(
      masterQueue,
      'landing.exchange',
      'form.submission.sync',
    );

    // صف‌های per-node رو هم assert می‌کنیم
    const nodeQueues = await this.listNodeQueues();
    for (const q of nodeQueues) {
      await this.channel.assertQueue(q, { durable: true });
      await this.channel.bindQueue(q, 'landing.exchange', 'landing.sync');
      await this.channel.bindQueue(q, 'landing.exchange', 'form.sync');
    }

    this.logger.log(
      `Outbox connected to RabbitMQ (node queues: ${nodeQueues.length})`,
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
