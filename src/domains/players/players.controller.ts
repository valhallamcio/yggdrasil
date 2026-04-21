import type { Request, Response } from 'express';
import type { PlayersService } from './players.service.js';
import type {
  PlayerParams,
  PlayerServerParams,
  HistoryQuery,
  AnalyticsQuery,
  SearchQuery,
  LeaderboardQuery,
  SkinQuery,
  EditPositionBody,
  EditInventoryBody,
  EditStatsBody,
} from './players.schema.js';

export class PlayersController {
  constructor(private readonly service: PlayersService) {}

  list = async (_req: Request, res: Response): Promise<void> => {
    const data = this.service.getOnlinePlayers();
    res.json({ data });
  };

  getOne = async (req: Request, res: Response): Promise<void> => {
    const { nick } = req.params as unknown as PlayerParams;
    const data = await this.service.getPlayer(nick);
    res.json({ data });
  };

  search = async (req: Request, res: Response): Promise<void> => {
    const { q, limit } = req.query as unknown as SearchQuery;
    const data = await this.service.searchPlayers(q, limit);
    res.json({ data });
  };

  leaderboard = async (req: Request, res: Response): Promise<void> => {
    const { sort, limit, tag } = req.query as unknown as LeaderboardQuery;
    const data = await this.service.getLeaderboard(sort, limit, tag);
    res.json({ data });
  };

  history = async (req: Request, res: Response): Promise<void> => {
    const { from, to, server, granularity } = req.query as unknown as HistoryQuery;
    const data = await this.service.getPlayerHistory(from, to ?? new Date(), server, granularity);
    res.json({ data });
  };

  analytics = async (req: Request, res: Response): Promise<void> => {
    const { server } = req.query as unknown as AnalyticsQuery;
    const data = await this.service.getAnalytics(server);
    res.json({ data });
  };

  skin = async (req: Request, res: Response): Promise<void> => {
    const { nick } = req.params as unknown as PlayerParams;
    const { size } = req.query as unknown as SkinQuery;
    res.redirect(this.service.getSkinUrl(nick, size));
  };

  getStats = async (req: Request, res: Response): Promise<void> => {
    const { nick, tag } = req.params as unknown as PlayerServerParams;
    const data = await this.service.getPlayerStats(nick, tag);
    res.json({ data });
  };

  updateStats = async (req: Request, res: Response): Promise<void> => {
    const { nick, tag } = req.params as unknown as PlayerServerParams;
    const { stats } = req.body as EditStatsBody;
    await this.service.updatePlayerStats(nick, tag, stats);
    res.status(204).send();
  };

  getInventory = async (req: Request, res: Response): Promise<void> => {
    const { nick, tag } = req.params as unknown as PlayerServerParams;
    const data = await this.service.getPlayerInventory(nick, tag);
    res.json({ data });
  };

  updateInventory = async (req: Request, res: Response): Promise<void> => {
    const { nick, tag } = req.params as unknown as PlayerServerParams;
    const { inventory } = req.body as EditInventoryBody;
    await this.service.updatePlayerInventory(nick, tag, inventory);
    res.status(204).send();
  };

  getPosition = async (req: Request, res: Response): Promise<void> => {
    const { nick, tag } = req.params as unknown as PlayerServerParams;
    const data = await this.service.getPlayerPosition(nick, tag);
    res.json({ data });
  };

  updatePosition = async (req: Request, res: Response): Promise<void> => {
    const { nick, tag } = req.params as unknown as PlayerServerParams;
    const body = req.body as EditPositionBody;
    await this.service.updatePlayerPosition(nick, tag, body);
    res.status(204).send();
  };

  getAdvancements = async (req: Request, res: Response): Promise<void> => {
    const { nick, tag } = req.params as unknown as PlayerServerParams;
    const data = await this.service.getPlayerAdvancements(nick, tag);
    res.json({ data });
  };
}
