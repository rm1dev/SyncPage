import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EdgeNode, EdgeNodeStatus, Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import axios from 'axios';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateEdgeNodeDto, UpdateEdgeNodeDto } from './dto/edge-node.dto';

export type EdgeNodeWithInstall = EdgeNode & {
  installCommand: string;
  updateCommand: string;
  bootstrapUrl: string;
};

@Injectable()
export class NodesService {
  private readonly logger = new Logger(NodesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async list(): Promise<EdgeNodeWithInstall[]> {
    const nodes = await this.prisma.edgeNode.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return nodes.map((n) => this.withInstallMeta(n));
  }

  async getById(id: string): Promise<EdgeNodeWithInstall> {
    const node = await this.prisma.edgeNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('Node not found');
    return this.withInstallMeta(node);
  }

  async create(dto: CreateEdgeNodeDto): Promise<EdgeNodeWithInstall> {
    const id = randomUUID();
    const installToken = randomBytes(24).toString('hex');
    const queueName = `landing.sync.${id.slice(0, 8)}`;
    const port = dto.port ?? 3000;

    const node = await this.prisma.edgeNode.create({
      data: {
        id,
        title: dto.title.trim(),
        host: dto.host.trim(),
        port,
        queueName,
        installToken,
        notes: dto.notes?.trim() || null,
        status: EdgeNodeStatus.PENDING,
      },
    });

    this.logger.log(`Edge node created: ${node.title} (${node.id})`);
    return this.withInstallMeta(node);
  }

  async update(id: string, dto: UpdateEdgeNodeDto): Promise<EdgeNodeWithInstall> {
    await this.getById(id);
    const data: Prisma.EdgeNodeUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.host !== undefined) data.host = dto.host.trim();
    if (dto.port !== undefined) data.port = dto.port;
    if (dto.notes !== undefined) data.notes = dto.notes.trim() || null;

    const node = await this.prisma.edgeNode.update({ where: { id }, data });
    return this.withInstallMeta(node);
  }

  async remove(id: string): Promise<void> {
    await this.getById(id);
    await this.prisma.edgeNode.delete({ where: { id } });
  }

  /** رفرش توکن نصب — کامند قبلی باطل می‌شه */
  async regenerateToken(id: string): Promise<EdgeNodeWithInstall> {
    await this.getById(id);
    const installToken = randomBytes(24).toString('hex');
    const node = await this.prisma.edgeNode.update({
      where: { id },
      data: { installToken },
    });
    return this.withInstallMeta(node);
  }

  /** بوت‌استرپ بی‌سوال برای اسکریپت نصب نود */
  async getBootstrapByToken(token: string) {
    const node = await this.prisma.edgeNode.findUnique({
      where: { installToken: token },
    });
    if (!node) throw new NotFoundException('Invalid install token');

    const rabbitmqUrl =
      this.config.get<string>('rabbitmqPublicUrl') ||
      this.config.get<string>('rabbitmqUrl')!;
    const masterInternalUrl =
      this.config.get<string>('masterInternalUrl') || 'http://localhost:3000';
    const publicBaseUrl =
      this.config.get<string>('publicBaseUrl') || 'http://localhost';
    const githubRepo =
      this.config.get<string>('githubRepo') || 'rm1dev/SyncPage';
    const githubBranch = this.config.get<string>('githubBranch') || 'main';

    return {
      nodeId: node.id,
      title: node.title,
      host: node.host,
      port: node.port,
      queueName: node.queueName,
      nodeRole: 'EDGE',
      rabbitmqUrl,
      rabbitmqQueue: node.queueName,
      rabbitmqMasterQueue: 'form.submission',
      masterInternalUrl,
      publicBaseUrl,
      githubRepo,
      githubBranch,
      databaseName: `syncpage_edge_${node.id.slice(0, 8)}`,
      databaseUser: 'syncpage',
      // پسورد DB محلی نود — تصادفی ولی ثابت از توکن (قابل بازتولید نیست، فقط همین بار)
      // واقعاً رندوم می‌ذاریم؛ اسکریپت همون لحظه می‌گیره و توی .env می‌نویسه
      databasePassword: randomBytes(12).toString('hex'),
    };
  }

  /** فقط لوکال / هم‌محل با Master — برای نود ریموت host.docker.internal اشتباهه */
  private isLoopbackHost(host: string): boolean {
    const h = host.trim().toLowerCase();
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '::1' ||
      h === '0.0.0.0' ||
      h === 'host.docker.internal'
    );
  }

  /** IP/hostnameهای خودِ Master — اگه host نود یکی از اینا باشه یعنی هم‌محل روی همین سرور */
  private masterOwnHosts(): Set<string> {
    const hosts = new Set<string>();
    for (const raw of [
      this.config.get<string>('publicBaseUrl'),
      this.config.get<string>('masterInternalUrl'),
      this.config.get<string>('rabbitmqPublicUrl'),
    ]) {
      if (!raw) continue;
      try {
        const withProto = raw.includes('://') ? raw : `http://${raw}`;
        const hostname = new URL(withProto).hostname;
        if (hostname) hosts.add(hostname.toLowerCase());
      } catch {
        /* URL خراب بود، رد شو */
      }
    }
    return hosts;
  }

  private shouldTryDockerGateway(host: string): boolean {
    if (this.isLoopbackHost(host)) return true;
    return this.masterOwnHosts().has(host.trim().toLowerCase());
  }

  /** آدرس‌های health برای تایید — docker gateway فقط برای نود هم‌محل */
  private healthUrls(node: EdgeNode): string[] {
    const hosts = [node.host];
    if (this.shouldTryDockerGateway(node.host)) {
      hosts.push('host.docker.internal');
    }
    const unique = [...new Set(hosts.filter(Boolean))];
    return unique.map((h) => `http://${h}:${node.port}/api/health`);
  }

  /** پیام خطای شبکه/HTTP رو برای پنل فارسی می‌کنه */
  private translateProbeError(err: unknown, url: string): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ECONNREFUSED/i.test(msg)) {
      return `اتصال رد شد — سرویس روی این آدرس پاسخ نمی‌دهد (${url})`;
    }
    if (/ETIMEDOUT|timeout of \d+ms exceeded|Timeout/i.test(msg)) {
      return `زمان اتصال تمام شد (${url})`;
    }
    if (/ENOTFOUND/i.test(msg)) {
      return `آدرس پیدا نشد (${url})`;
    }
    if (/ECONNRESET|reset by peer/i.test(msg)) {
      return `اتصال قطع شد (${url})`;
    }
    if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) {
      return `شبکه به این آدرس دسترسی ندارد (${url})`;
    }
    if (/certificate|SSL|TLS/i.test(msg)) {
      return `خطای گواهی SSL/TLS (${url})`;
    }
    return `${msg} (${url})`;
  }

  /**
   * فقط health رو می‌خونه (بدون عوض کردن وضعیت) — برای چک نسخه
   */
  async probeHealth(id: string): Promise<{
    ok: boolean;
    version?: string;
    role?: string;
    nodeId?: string;
    url?: string;
  } | null> {
    const node = await this.prisma.edgeNode.findUnique({ where: { id } });
    if (!node) return null;

    for (const url of this.healthUrls(node)) {
      try {
        const { data, status } = await axios.get(url, {
          timeout: 4000,
          validateStatus: () => true,
        });
        if (status === 200 && data?.ok) {
          return {
            ok: true,
            version: data.version ? String(data.version) : undefined,
            role: data.role ? String(data.role) : undefined,
            nodeId: data.nodeId ? String(data.nodeId) : undefined,
            url,
          };
        }
      } catch {
        /* آدرس بعدی */
      }
    }
    return { ok: false };
  }

  /**
   * از Master به health نود HTTP می‌زنیم و وضعیت رو آپدیت می‌کنیم
   */
  async verify(id: string): Promise<EdgeNodeWithInstall> {
    const node = await this.prisma.edgeNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('نود پیدا نشد');

    const urls = this.healthUrls(node);
    const errors: string[] = [];

    for (const url of urls) {
      try {
        const { data, status } = await axios.get(url, {
          timeout: 8000,
          validateStatus: () => true,
        });

        if (status !== 200 || !data?.ok) {
          errors.push(`پاسخ نامعتبر از health: HTTP ${status} (${url})`);
          continue;
        }

        const role = String(data.role || '').toUpperCase();
        if (role !== 'EDGE' && role !== 'SLAVE') {
          errors.push(`نقش غیرمنتظره: ${data.role} (${url})`);
          continue;
        }

        if (data.nodeId && data.nodeId !== node.id) {
          errors.push(
            `شناسه نود مطابقت ندارد: انتظار ${node.id}، دریافت ${data.nodeId} (${url})`,
          );
          continue;
        }

        const updated = await this.prisma.edgeNode.update({
          where: { id },
          data: {
            status: EdgeNodeStatus.ONLINE,
            lastSeenAt: new Date(),
            lastError: null,
          },
        });
        this.logger.log(`Node verified online: ${node.title} via ${url}`);
        return this.withInstallMeta(updated);
      } catch (err) {
        errors.push(this.translateProbeError(err, url));
      }
    }

    const lastMessage =
      errors.join(' | ') ||
      `هیچ آدرس health برای ${node.host}:${node.port} امتحان نشد`;

    const updated = await this.prisma.edgeNode.update({
      where: { id },
      data: {
        status: EdgeNodeStatus.OFFLINE,
        lastError: lastMessage.slice(0, 500),
      },
    });
    this.logger.warn(`Node verify failed (${node.title}): ${lastMessage}`);
    throw new BadRequestException({
      message: `تایید ناموفق: ${lastMessage}`,
      node: this.withInstallMeta(updated),
    });
  }

  /** صف‌های همه نودها برای Outbox */
  async listQueueNames(): Promise<string[]> {
    const nodes = await this.prisma.edgeNode.findMany({
      select: { queueName: true },
    });
    return nodes.map((n) => n.queueName);
  }

  private withInstallMeta(node: EdgeNode): EdgeNodeWithInstall {
    const publicBaseUrl = (
      this.config.get<string>('publicBaseUrl') || 'http://localhost'
    ).replace(/\/$/, '');
    const githubRepo =
      this.config.get<string>('githubRepo') || 'rm1dev/SyncPage';
    const githubBranch = this.config.get<string>('githubBranch') || 'main';
    const scriptUrl = `https://raw.githubusercontent.com/${githubRepo}/${githubBranch}/install-node.sh`;
    const updateScriptUrl = `https://raw.githubusercontent.com/${githubRepo}/${githubBranch}/update-node.sh`;
    const bootstrapUrl = `${publicBaseUrl}/api/nodes/bootstrap/${node.installToken}`;
    // کامند silent — بدون سوال
    const installCommand = `bash <(curl -Ls ${scriptUrl}) ${bootstrapUrl}`;
    const updateCommand = `bash <(curl -Ls ${updateScriptUrl})`;

    return { ...node, installCommand, updateCommand, bootstrapUrl };
  }
}
