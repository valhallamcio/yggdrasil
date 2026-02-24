import { config } from '../../config/index.js';
import { AppError } from '../../shared/errors/app-error.js';
import { logger } from '../../core/logger/index.js';
import type { PterodactylFileEntry, PterodactylWsCredentials } from './servers.types.js';

export class PterodactylError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 502, 'PTERODACTYL_ERROR', details);
  }
}

export class PterodactylClient {
  private get baseUrl(): string {
    if (!config.PTERODACTYL_URL) throw new PterodactylError('PTERODACTYL_URL is not configured');
    return config.PTERODACTYL_URL;
  }

  private get apiKey(): string {
    if (!config.PTERODACTYL_API_KEY) throw new PterodactylError('PTERODACTYL_API_KEY is not configured');
    return config.PTERODACTYL_API_KEY;
  }

  private async request<T>(
    serverId: string,
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}/api/client/servers/${serverId}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'Application/vnd.pterodactyl.v1+json',
        ...options.headers,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error({ status: res.status, body, serverId, path }, 'Pterodactyl API error');
      throw new PterodactylError(`Pterodactyl API returned ${res.status}`, { status: res.status });
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async getWsCredentials(serverId: string): Promise<PterodactylWsCredentials> {
    const data = await this.request<{ data: PterodactylWsCredentials }>(serverId, '/websocket');
    return data.data;
  }

  async sendCommand(serverId: string, command: string): Promise<void> {
    await this.request<void>(serverId, '/command', {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
  }

  async sendPowerAction(
    serverId: string,
    signal: 'start' | 'stop' | 'restart' | 'kill',
  ): Promise<void> {
    await this.request<void>(serverId, '/power', {
      method: 'POST',
      body: JSON.stringify({ signal }),
    });
  }

  async listFiles(serverId: string, directory = '/'): Promise<PterodactylFileEntry[]> {
    const data = await this.request<{ data: PterodactylFileEntry[] }>(
      serverId,
      `/files/list?directory=${encodeURIComponent(directory)}`,
    );
    return data.data;
  }

  async readFile(serverId: string, filePath: string): Promise<string> {
    const url = `${this.baseUrl}/api/client/servers/${serverId}/files/contents?file=${encodeURIComponent(filePath)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'text/plain',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new PterodactylError(`Pterodactyl file read returned ${res.status}`);
    return res.text();
  }

  async writeFile(serverId: string, filePath: string, content: string): Promise<void> {
    const url = `${this.baseUrl}/api/client/servers/${serverId}/files/write?file=${encodeURIComponent(filePath)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'text/plain',
      },
      body: content,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new PterodactylError(`Pterodactyl file write returned ${res.status}`);
  }
}
