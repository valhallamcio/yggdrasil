import type { Request, Response } from 'express';
import type { ServerRegistryRepository } from './server-registry.repository.js';
import type { ServerParams } from './servers.schema.js';
import type { ServerRegistryDocument, ServerRegistryDto } from './servers.types.js';
import { NotFoundError } from '../../shared/errors/index.js';

function toDto(doc: ServerRegistryDocument): ServerRegistryDto {
  return {
    tag: doc.tag,
    name: doc.name,
    desc: doc.desc,
    color: doc.color,
    image: doc.image,
    genre: doc.genre,
    platform: doc.platform,
    serverVersion: doc.serverVersion,
    modpackVersion: doc.modpackVersion,
    earlyAccess: doc.earlyAccess,
    active: doc.active,
    lastSeenAt: doc.lastSeenAt.toISOString(),
  };
}

export class ServerRegistryController {
  constructor(private readonly repo: ServerRegistryRepository) {}

  list = async (_req: Request, res: Response): Promise<void> => {
    const docs = await this.repo.findAllEntries();
    res.json({ data: docs.map(toDto) });
  };

  getOne = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as ServerParams;
    const doc = await this.repo.findByTag(server);
    if (!doc) throw new NotFoundError('Server', server);
    res.json({ data: toDto(doc) });
  };
}
