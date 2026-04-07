import type { Request, Response } from 'express';
import type { ServersService } from './servers.service.js';
import type {
  ServerParams,
  CommandBody,
  PowerBody,
  FileListQuery,
  FileReadQuery,
  FileWriteQuery,
  FileWriteBody,
  HistoryQuery,
  LogsQuery,
  UpdateServerBody,
} from './servers.schema.js';

export class ServersController {
  constructor(private readonly service: ServersService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const data = await this.service.getServers(req.authenticated ?? false);
    res.json({ data });
  };

  getOne = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as ServerParams;
    const data = await this.service.getServer(server, req.authenticated ?? false);
    res.json({ data });
  };

  getHistory = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as ServerParams;
    const { from, to } = req.query as unknown as HistoryQuery;
    const data = await this.service.getHistory(server, from, to ?? new Date());
    res.json({ data });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as ServerParams;
    const fields = req.body as UpdateServerBody;
    await this.service.updateServer(server, fields);
    res.status(204).send();
  };

  sendCommand = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as ServerParams;
    const { command } = req.body as CommandBody;
    await this.service.sendCommand(server, command);
    res.status(204).send();
  };

  sendPower = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as ServerParams;
    const { signal } = req.body as PowerBody;
    await this.service.sendPowerAction(server, signal);
    res.status(204).send();
  };

  listFiles = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as ServerParams;
    const { directory } = req.query as unknown as FileListQuery;
    const data = await this.service.listFiles(server, directory);
    res.json({ data });
  };

  readFile = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as ServerParams;
    const { file } = req.query as unknown as FileReadQuery;
    const content = await this.service.readFile(server, file);
    res.type('text/plain').send(content);
  };

  writeFile = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as ServerParams;
    const { file } = req.query as unknown as FileWriteQuery;
    const { content } = req.body as FileWriteBody;
    await this.service.writeFile(server, file, content);
    res.status(204).send();
  };

  getConsoleLogs = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.params as unknown as ServerParams;
    const { lines } = req.query as unknown as LogsQuery;
    const content = await this.service.getConsoleLogs(server, lines);
    res.type('text/plain').send(content);
  };
}
