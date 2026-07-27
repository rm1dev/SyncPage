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

  /**
   * از Master به health نود HTTP می‌زنیم و وضعیت رو آپدیت می‌کنیم
   */
  async verify(id: string): Promise<EdgeNodeWithInstall> {
    const node = await this.prisma.edgeNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('Node not found');

    const url = `http://${node.host}:${node.port}/api/health`;
    try {
      const { data, status } = await axios.get(url, {
        timeout: 8000,
        validateStatus: () => true,
      });

      if (status !== 200 || !data?.ok) {
        throw new Error(`Health returned HTTP ${status}`);
      }

      const role = String(data.role || '').toUpperCase();
      if (role !== 'EDGE' && role !== 'SLAVE') {
        throw new Error(`Unexpected role: ${data.role}`);
      }

      if (data.nodeId && data.nodeId !== node.id) {
        throw new Error(
          `Node ID mismatch: expected ${node.id}, got ${data.nodeId}`,
        );
      }

      const updated = await this.prisma.edgeNode.update({
        where: { id },
        data: {
          status: EdgeNodeStatus.ONLINE,
          lastSeenAt: new Date(),
          lastError: null,
        },
      });
      this.logger.log(`Node verified online: ${node.title}`);
      return this.withInstallMeta(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const updated = await this.prisma.edgeNode.update({
        where: { id },
        data: {
          status: EdgeNodeStatus.OFFLINE,
          lastError: message.slice(0, 500),
        },
      });
      this.logger.warn(`Node verify failed (${node.title}): ${message}`);
      throw new BadRequestException({
        message: `Verify failed: ${message}`,
        node: this.withInstallMeta(updated),
      });
    }
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
    const bootstrapUrl = `${publicBaseUrl}/api/nodes/bootstrap/${node.installToken}`;
    // کامند silent با pipe — با sudo هم درست کار می‌کنه (process substitution نه)
    const installCommand = `curl -fsSL ${scriptUrl} | sudo bash -s -- ${bootstrapUrl}`;

    return { ...node, installCommand, bootstrapUrl };
  }
}
