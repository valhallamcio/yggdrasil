import type { Request, Response } from 'express';
import type { DonationsService } from './donations.service.js';
import { logger } from '../../core/logger/index.js';

export class DonationsController {
  constructor(private readonly service: DonationsService) {}

  handleKofi = async (req: Request, res: Response): Promise<void> => {
    const rawData = (req.body as Record<string, unknown>)['data'];
    if (typeof rawData !== 'string') {
      res.status(200).json({ received: true });
      return;
    }

    const event = this.service.processKofi(rawData);
    logger.info(
      { provider: 'kofi', donor: event.donorName, amount: event.amount, type: event.rawEventType },
      'Ko-fi webhook processed'
    );

    await this.service.save(event);
    this.service.notifyDiscord(event);
    res.status(200).json({ received: true });
  };

  handlePatreon = async (req: Request, res: Response): Promise<void> => {
    const signature = req.headers['x-patreon-signature'] as string | undefined;
    const eventType = req.headers['x-patreon-event'] as string | undefined;

    if (!signature) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing Patreon signature' } });
      return;
    }

    const rawBody = req.rawBody ?? Buffer.alloc(0);
    this.service.verifyPatreonSignature(rawBody, signature);

    const event = this.service.processPatreon(req.body as unknown, eventType ?? 'unknown');
    logger.info(
      { provider: 'patreon', donor: event.donorName, amount: event.amount, type: event.rawEventType },
      'Patreon webhook processed'
    );

    await this.service.save(event);
    this.service.notifyDiscord(event);
    res.status(200).json({ received: true });
  };
}
