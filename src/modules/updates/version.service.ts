import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { getLocalVersion, isOutdated } from '../../common/app-version';
import { NodesService } from '../nodes/nodes.service';

export type UpdateStatus = {
  localVersion: string;
  latestVersion: string | null;
  outdated: boolean;
  updateCommand: string;
  checkError?: string;
};

export type NodeVersionRow = {
  id: string;
  title: string;
  host: string;
  port: number;
  status: string;
  localVersion: string | null;
  outdated: boolean;
  unreachable: boolean;
  updateCommand: string;
};

@Injectable()
export class VersionService {
  private readonly logger = new Logger(VersionService.name);
  private cache: { at: number; latest: string | null; error?: string } | null =
    null;
  private readonly cacheMs = 5 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    private readonly nodes: NodesService,
  ) {}

  masterUpdateCommand(): string {
    const { repo, branch } = this.github();
    return `bash <(curl -Ls https://raw.githubusercontent.com/${repo}/${branch}/update.sh)`;
  }

  nodeUpdateCommand(): string {
    const { repo, branch } = this.github();
    return `bash <(curl -Ls https://raw.githubusercontent.com/${repo}/${branch}/update-node.sh)`;
  }

  async getMasterStatus(): Promise<UpdateStatus> {
    const localVersion = getLocalVersion();
    const { latest, error } = await this.fetchLatestVersion();
    return {
      localVersion,
      latestVersion: latest,
      outdated: latest ? isOutdated(localVersion, latest) : false,
      updateCommand: this.masterUpdateCommand(),
      checkError: error,
    };
  }

  /** نسخهٔ زندهٔ نودها رو از health می‌خونه و با GitHub مقایسه می‌کنه */
  async getNodesVersionStatus(): Promise<{
    latestVersion: string | null;
    nodeUpdateCommand: string;
    nodes: NodeVersionRow[];
  }> {
    const { latest } = await this.fetchLatestVersion();
    const list = await this.nodes.list();
    const nodeUpdateCommand = this.nodeUpdateCommand();

    const nodes = await Promise.all(
      list.map(async (n) => {
        const probed = await this.nodes.probeHealth(n.id).catch(() => null);
        const localVersion = probed?.version ?? null;
        const unreachable = !probed?.ok;
        const outdated =
          !!latest && !!localVersion && isOutdated(localVersion, latest);
        return {
          id: n.id,
          title: n.title,
          host: n.host,
          port: n.port,
          status: n.status,
          localVersion,
          outdated,
          unreachable,
          updateCommand: nodeUpdateCommand,
        };
      }),
    );

    return { latestVersion: latest, nodeUpdateCommand, nodes };
  }

  private github() {
    return {
      repo: this.config.get<string>('githubRepo') || 'rm1dev/SyncPage',
      branch: this.config.get<string>('githubBranch') || 'main',
    };
  }

  private async fetchLatestVersion(): Promise<{
    latest: string | null;
    error?: string;
  }> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.cacheMs) {
      return { latest: this.cache.latest, error: this.cache.error };
    }

    const { repo, branch } = this.github();
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/package.json`;
    try {
      const { data } = await axios.get<{ version?: string }>(url, {
        timeout: 8000,
        validateStatus: (s: number) => s === 200,
      });
      const latest = String(data?.version || '').replace(/^v/i, '') || null;
      this.cache = { at: now, latest };
      return { latest };
    } catch (err) {
      const error =
        err instanceof Error ? err.message : 'Failed to fetch GitHub version';
      this.logger.warn(`GitHub version check failed: ${error}`);
      this.cache = { at: now, latest: null, error };
      return { latest: null, error };
    }
  }
}
