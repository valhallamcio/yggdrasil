import crypto from 'node:crypto';
import { config } from '../../config/index.js';
import { logger } from '../../core/logger/index.js';
import { eventBus } from '../../core/event-bus/index.js';
import { UnauthorizedError, InternalError } from '../../shared/errors/index.js';
import { kofiPayloadSchema } from './donations.schema.js';
import type { DonationEvent } from './donations.types.js';

const KOFI_PUBLIC_TYPES = new Set(['Donation', 'Subscription']);
const PATREON_PUBLIC_EVENTS = new Set(['members:pledge:create']);

export class DonationsService {
  // ── Ko-fi ──────────────────────────────────────────────────────────────────

  processKofi(rawDataString: string): DonationEvent {
    if (!config.KOFI_VERIFICATION_TOKEN) {
      throw new InternalError('Ko-fi verification token not configured');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataString) as unknown;
    } catch {
      throw new UnauthorizedError('Invalid Ko-fi payload: data is not valid JSON');
    }

    const result = kofiPayloadSchema.safeParse(parsed);
    if (!result.success) {
      throw new UnauthorizedError('Invalid Ko-fi payload structure');
    }

    const payload = result.data;

    const expectedBuf = Buffer.from(config.KOFI_VERIFICATION_TOKEN);
    const receivedBuf = Buffer.from(payload.verification_token);
    const tokenValid =
      expectedBuf.length === receivedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, receivedBuf);

    if (!tokenValid) {
      logger.warn('Ko-fi verification token mismatch');
      throw new UnauthorizedError('Invalid Ko-fi verification token');
    }

    return {
      provider: 'kofi',
      donorName: payload.from_name,
      amount: payload.amount,
      currency: payload.currency,
      message: payload.message ?? undefined,
      isSubscription: payload.is_subscription_payment ?? false,
      rawEventType: payload.type,
      isPublic: KOFI_PUBLIC_TYPES.has(payload.type),
    };
  }

  // ── Patreon ────────────────────────────────────────────────────────────────

  verifyPatreonSignature(rawBody: Buffer, signature: string): void {
    if (!config.PATREON_WEBHOOK_SECRET) {
      throw new InternalError('Patreon webhook secret not configured');
    }

    const expected = crypto
      .createHmac('md5', config.PATREON_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signature);
    const signatureValid =
      expectedBuf.length === receivedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, receivedBuf);

    if (!signatureValid) {
      logger.warn('Patreon HMAC-MD5 signature mismatch');
      throw new UnauthorizedError('Invalid Patreon signature');
    }
  }

  processPatreon(body: unknown, eventType: string): DonationEvent {
    const payload = body as {
      data: { attributes: { amount_cents: number; currency: string; note?: string } };
      included?: Array<{ type: string; attributes: { full_name?: string; name?: string } }>;
    };

    const amountCents = payload.data?.attributes?.amount_cents ?? 0;
    const currency = payload.data?.attributes?.currency ?? 'USD';
    const note = payload.data?.attributes?.note;

    const patronUser = payload.included?.find((inc) => inc.type === 'user');
    const donorName =
      patronUser?.attributes.full_name ?? patronUser?.attributes.name ?? 'Anonymous';

    return {
      provider: 'patreon',
      donorName,
      amount: (amountCents / 100).toFixed(2),
      currency,
      message: note,
      isSubscription: true,
      rawEventType: eventType,
      isPublic: PATREON_PUBLIC_EVENTS.has(eventType),
    };
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  formatDiscordMessage(event: DonationEvent): string {
    const providerLabel = event.provider === 'kofi' ? 'Ko-fi' : 'Patreon';
    const amountStr = `${event.currency} ${event.amount}`;

    let action: string;
    if (event.provider === 'kofi') {
      switch (event.rawEventType) {
        case 'Subscription':
          action = `just subscribed for **${amountStr}/mo**`;
          break;
        case 'Commission':
          action = `commissioned for **${amountStr}**`;
          break;
        case 'Shop Order':
          action = `placed a shop order for **${amountStr}**`;
          break;
        default:
          action = `just donated **${amountStr}**`;
      }
    } else {
      switch (event.rawEventType) {
        case 'members:pledge:create':
          action = `just pledged **${amountStr}**`;
          break;
        case 'members:pledge:update':
          action = `updated their pledge to **${amountStr}**`;
          break;
        case 'members:pledge:delete':
          action = 'cancelled their pledge';
          break;
        default:
          action = `triggered event \`${event.rawEventType}\``;
      }
    }

    const base = `**${event.donorName}** ${action} via ${providerLabel}!`;
    return event.message ? `${base}\n> *${event.message}*` : base;
  }

  // ── Notify ─────────────────────────────────────────────────────────────────

  notifyDiscord(event: DonationEvent): void {
    const channelId = event.isPublic
      ? config.DISCORD_DONATIONS_CHANNEL_ID
      : config.DISCORD_DONATIONS_LOG_CHANNEL_ID;

    if (!channelId) {
      logger.warn(
        { provider: event.provider, isPublic: event.isPublic },
        'No Discord channel configured for donation notification'
      );
      return;
    }

    const message = this.formatDiscordMessage(event);
    eventBus.emit('donation.received', { channelId, message });
  }
}
