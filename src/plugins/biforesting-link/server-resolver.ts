import { ServersRepository } from '../../domains/servers/servers.repository.js';
import { logger } from '../../core/logger/index.js';
import type { LinkIdentity } from './types.js';

/**
 * Resolves a link's raw `serverId` (from the hello frame) to a known server. The mod should be
 * configured with the **Pterodactyl serverId** (unique per instance); we also accept a tag and
 * fall back to the raw value. `instanceKey` is computed exactly like `PterodactylWsManager`
 * (`pterodactyl-ws.manager.ts` — `tag` for a single instance, `tag:serverId` when grouped) so link
 * data keys consistently with the existing stats pipeline.
 */

interface ServerEntry {
  serverOid: import('mongodb').ObjectId;
  tag: string;
  serverId: string;
  name: string;
}

const CACHE_TTL_MS = 60_000;

class ServerResolver {
  private readonly repo = new ServersRepository();
  private byServerId = new Map<string, ServerEntry>();
  private tagGroups = new Map<string, string[]>(); // tag → serverId[]
  private byTag = new Map<string, ServerEntry[]>();
  private loadedAt = 0;

  private async refresh(): Promise<void> {
    const servers = await this.repo.findAllForSync();
    const byServerId = new Map<string, ServerEntry>();
    const tagGroups = new Map<string, string[]>();
    const byTag = new Map<string, ServerEntry[]>();
    for (const s of servers) {
      const entry: ServerEntry = { serverOid: s._id, tag: s.tag, serverId: s.serverId, name: s.name };
      byServerId.set(s.serverId, entry);

      const group = tagGroups.get(s.tag);
      if (group) group.push(s.serverId);
      else tagGroups.set(s.tag, [s.serverId]);

      const list = byTag.get(s.tag);
      if (list) list.push(entry);
      else byTag.set(s.tag, [entry]);
    }
    this.byServerId = byServerId;
    this.tagGroups = tagGroups;
    this.byTag = byTag;
    this.loadedAt = Date.now();
  }

  private instanceKey(entry: ServerEntry): string {
    const group = this.tagGroups.get(entry.tag);
    return group && group.length > 1 ? `${entry.tag}:${entry.serverId}` : entry.tag;
  }

  async resolve(linkServerId: string): Promise<LinkIdentity> {
    if (Date.now() - this.loadedAt > CACHE_TTL_MS) {
      try {
        await this.refresh();
      } catch (err) {
        logger.warn({ err }, 'biforesting-link: server cache refresh failed; using stale data');
      }
    }

    // 1. Instance-precise match on Pterodactyl serverId.
    let entry = this.byServerId.get(linkServerId);
    if (!entry) {
      // The id may have been added after the last refresh — try once more.
      try {
        await this.refresh();
      } catch {
        /* keep stale */
      }
      entry = this.byServerId.get(linkServerId);
    }
    if (entry) {
      return {
        linkServerId,
        tag: entry.tag,
        instanceKey: this.instanceKey(entry),
        name: entry.name,
        serverId: entry.serverId,
        serverOid: entry.serverOid,
        resolved: true,
      };
    }

    // 2. Tag match.
    const tagMatches = this.byTag.get(linkServerId);
    if (tagMatches && tagMatches.length > 0) {
      if (tagMatches.length === 1) {
        const only = tagMatches[0]!;
        return {
          linkServerId,
          tag: only.tag,
          instanceKey: this.instanceKey(only),
          name: only.name,
          serverId: only.serverId,
          serverOid: only.serverOid,
          resolved: true,
        };
      }
      logger.warn(
        { linkServerId, instances: tagMatches.length },
        'biforesting-link: serverId matched a tag with multiple instances — keying at group level; set BIFORESTING_YGGDRASIL_SERVER_ID to the Pterodactyl serverId for per-instance precision',
      );
      return {
        linkServerId,
        tag: linkServerId,
        instanceKey: linkServerId,
        name: null,
        serverId: null,
        serverOid: null,
        resolved: true,
      };
    }

    // 3. Unresolved — still observable, keyed by the raw id.
    logger.warn({ linkServerId }, 'biforesting-link: unresolved serverId (no matching server doc)');
    return {
      linkServerId,
      tag: null,
      instanceKey: linkServerId,
      name: null,
      serverId: null,
      serverOid: null,
      resolved: false,
    };
  }
}

export const serverResolver = new ServerResolver();
