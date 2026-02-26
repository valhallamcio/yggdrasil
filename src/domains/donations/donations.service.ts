import crypto from 'node:crypto';
import { config } from '../../config/index.js';
import { logger } from '../../core/logger/index.js';
import { eventBus } from '../../core/event-bus/index.js';
import { UnauthorizedError, InternalError } from '../../shared/errors/index.js';
import { kofiPayloadSchema } from './donations.schema.js';
import type { DonationEvent } from './donations.types.js';
import type { DonationsRepository } from './donations.repository.js';

const KOFI_PUBLIC_TYPES = new Set(['Donation', 'Subscription']);
const PATREON_PUBLIC_EVENTS = new Set(['members:pledge:create']);

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  return `${local}@\\*\\*\\*.\\*\\*\\*`;
}

function camelToTitle(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

export class DonationsService {
  constructor(private readonly repo: DonationsRepository) {}

  async save(event: DonationEvent): Promise<void> {
    await this.repo.insertOne({ ...event, createdAt: new Date() });
  }

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
      email: payload.email,
      isSubscription: payload.is_subscription_payment ?? false,
      isFirstSubscription: payload.is_first_subscription_payment ?? undefined,
      rawEventType: payload.type,
      isPublic: KOFI_PUBLIC_TYPES.has(payload.type),
      extras: {
        transactionId: payload.kofi_transaction_id,
        timestamp: payload.timestamp ?? null,
        messageId: payload.message_id ?? null,
        isKofiPublic: payload.is_public ?? null,
      },
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
      data: {
        attributes: {
          amount_cents?: number;
          currency?: string;
          note?: string;
          patron_status?: string;
          last_charge_date?: string;
          last_charge_status?: string;
          lifetime_support_cents?: number;
          pledge_relationship_start?: string;
          currently_entitled_amount_cents?: number;
          is_follower?: boolean;
        };
      };
      included?: Array<{
        type: string;
        attributes: { full_name?: string; name?: string; email?: string };
      }>;
    };

    const attrs = payload.data?.attributes;
    const amountCents = attrs?.amount_cents ?? 0;
    const currency = attrs?.currency ?? 'USD';
    const note = attrs?.note;

    const patronUser = payload.included?.find((inc) => inc.type === 'user');
    const donorName =
      patronUser?.attributes.full_name ?? patronUser?.attributes.name ?? 'Anonymous';

    return {
      provider: 'patreon',
      donorName,
      amount: (amountCents / 100).toFixed(2),
      currency,
      message: note,
      email: patronUser?.attributes.email,
      isSubscription: true,
      rawEventType: eventType,
      isPublic: PATREON_PUBLIC_EVENTS.has(eventType),
      extras: {
        patronStatus: attrs?.patron_status ?? null,
        lastChargeDate: attrs?.last_charge_date ?? null,
        lastChargeStatus: attrs?.last_charge_status ?? null,
        lifetimeSupportCents: attrs?.lifetime_support_cents ?? null,
        pledgeStart: attrs?.pledge_relationship_start ?? null,
        entitledAmountCents: attrs?.currently_entitled_amount_cents ?? null,
        isFollower: attrs?.is_follower ?? null,
      },
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
          action = event.isFirstSubscription
            ? `subscribed for **${amountStr}**/mo`
            : `donated **${amountStr}** (monthly)`;
          break;
        case 'Commission':
          action = `commissioned for **${amountStr}**`;
          break;
        case 'Shop Order':
          action = `placed a shop order for **${amountStr}**`;
          break;
        default:
          action = `donated **${amountStr}**`;
      }
    } else {
      switch (event.rawEventType) {
        case 'members:pledge:create':
          action = `pledged **${amountStr}**`;
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

  formatLogMessage(event: DonationEvent): string {
    const providerLabel = event.provider === 'kofi' ? 'Ko-fi' : 'Patreon';

    let subscriptionStr = event.isSubscription ? 'Yes' : 'No';
    if (event.isFirstSubscription) subscriptionStr += ' (first)';

    const lines = [
      `[${providerLabel}] ${event.rawEventType} from **${event.donorName}**`,
    ];

    if (event.email) {
      lines.push(`> **Email:** ${maskEmail(event.email)}`);
    }

    lines.push(
      `> **Amount:** ${event.currency} ${event.amount}`,
      `> **Event type:** ${event.rawEventType}`,
      `> **Subscription:** ${subscriptionStr}`,
      `> **Public:** ${event.isPublic ? 'Yes' : 'No'}`,
    );

    if (event.extras) {
      for (const [key, value] of Object.entries(event.extras)) {
        if (value == null) continue;
        lines.push(`> **${camelToTitle(key)}:** ${String(value)}`);
      }
    }

    if (event.message) {
      lines.push(`> **Message:** ${event.message}`);
    }

    return lines.join('\n');
  }

  // ── Notify ─────────────────────────────────────────────────────────────────

  notifyDiscord(event: DonationEvent): void {
    const logChannelId = config.DISCORD_DONATIONS_LOG_CHANNEL_ID;

    if (logChannelId) {
      const logMessage = this.formatLogMessage(event);
      eventBus.emit('donation.received', { channelId: logChannelId, message: logMessage });
    }

    if (event.isPublic) {
      const publicChannelId = config.DISCORD_DONATIONS_CHANNEL_ID;
      if (publicChannelId) {
        const publicMessage = this.formatDiscordMessage(event);
        eventBus.emit('donation.received', { channelId: publicChannelId, message: publicMessage });
      }
    }

    if (!logChannelId && !(event.isPublic && config.DISCORD_DONATIONS_CHANNEL_ID)) {
      logger.warn(
        { provider: event.provider, isPublic: event.isPublic },
        'No Discord channel configured for donation notification',
      );
    }
  }
}
