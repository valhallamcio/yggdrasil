import type { Collection, Document } from 'mongodb';
import { getClient } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';

/**
 * Mirrors posts from the Discord `#announcements` channel into Bifrost's
 * `notices` collection, so the ~85% of players who are not in Discord still
 * read them in game (plan-player-ux §4.C).
 *
 * The doc has to pass Bifrost's OWN validator (`src/plugins/notices/store.ts`)
 * untouched — this side invents no fields and no types. A mirrored post is a
 * `announcement` doc (the rotation type, carries `weight`), keyed by the
 * Discord message id so a restart, a re-delivery or an edit all land on the
 * same doc. A deleted post is expired via `expiresAt`, never hard-deleted:
 * `notices` treats an expired doc as evidence that stays listed.
 *
 * Everything here is best-effort. A handler that throws would take a gateway
 * event listener down with it, so every entry point catches and logs.
 */

/** `NOTICE_TEXT_CAPS.body` in Bifrost's `core/text-utils.ts`. */
export const NOTICE_BODY_CAP = 400;

/** Bifrost's `NOTICE_ID_RE` accepts this shape (`[a-z0-9][a-z0-9._-]*`, ≤128). */
const ID_PREFIX = 'announcement.discord.';

/** Who wrote the doc — staff see it in `/notices show`. */
export const MIRROR_ACTOR = 'yggdrasil:announcements-mirror';

const DAY_MS = 86_400_000;
const SNOWFLAKE_RE = /^\d{1,32}$/;

export interface MirrorOptions {
  /** Rendered in front of the body so a player knows where the post came from. */
  prefix: string;
  /** Rotation weight, 1..10 — Bifrost clamps it too. */
  weight: number;
  /** How long a mirrored post stays in the rotation. */
  ttlDays: number;
}

/** The parts of a Discord message the mirror reads. */
export interface MirrorSource {
  messageId: string;
  content: string;
  createdAt: Date;
  author?: string | null;
}

/** The `$set` payload — every field is one Bifrost's validator already knows. */
export interface MirrorNoticeSet {
  type: 'announcement';
  enabled: true;
  body: { en: string };
  weight: number;
  startsAt: Date;
  expiresAt: Date;
  updatedAt: Date;
  updatedBy: string;
  note: string;
}

export interface MirrorUpsert {
  id: string;
  set: MirrorNoticeSet;
}

/** `announcement.discord.<message id>` — the idempotency key. */
export function noticeIdFor(messageId: string): string {
  return `${ID_PREFIX}${messageId}`;
}

// Markdown link, before the emphasis markers are stripped: the URL is usually
// the whole point of an announcement, so it is kept next to the label.
const MD_LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]{1,300})\)/g;
// `<:name:123>` / `<a:name:123>` — the id is noise, the name reads fine.
const CUSTOM_EMOJI_RE = /<a?:([a-z0-9_]{1,32}):\d+>/gi;
// User/role/channel mentions and `<t:…>` timestamps: nothing readable survives
// the id, and this side has no resolver for them.
const MENTION_RE = /<(?:@[!&]?\d+|#\d+|t:\d+(?::[tTdDfFR])?|id:[a-z]+)>/g;
// Unicode emoji, variation selectors, ZWJ and regional indicators: a 1.7.10
// client draws a missing-glyph box for every one of them.
// Alternation, not one class: a class mixing pictographs with the joiner and
// the variation selector is exactly what `no-misleading-character-class` warns
// about, and each of these has to go on its own anyway.
// A base pictograph is only half of one: skin-tone modifiers (U+1F3FB-1F3FF) and
// TAG characters (U+E0020-E007F, the flag sequences) are separate code points, and
// stripping the base alone left the modifier behind as its own missing-glyph box.
const EMOJI_RE = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}]|\u{FE0F}|\u{FE0E}|\u{200D}|\u{20E3}/gu;
// Control characters and the § the chat renderer would read as a colour code.
// U+202A-202E and U+2066-2069 are the bidi overrides and isolates: they REORDER
// what follows them, so a post can be made to read as something it is not.
// eslint-disable-next-line no-control-regex -- stripping them IS the point
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u00a7\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u2028\u2029\ufeff]/g;

/**
 * Discord markdown/mentions/emoji ids → plain readable text, then the rules a
 * Bifrost chat card lives by: no `§`, no control characters, no newline (it
 * splits a 1.7.10 card), `<` escaped (MiniMessage would read it as a tag —
 * the escape is `\<`, never `&lt;`) and capped.
 */
export function sanitiseDiscordText(raw: unknown, cap = NOTICE_BODY_CAP): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  let text = raw;

  // Fences first: the language hint is markup, the code inside is content.
  text = text.replace(/```[a-z0-9+#-]*\n?([\s\S]*?)```/gi, '$1');
  text = text.replace(MD_LINK_RE, '$1 ($2)');
  text = text.replace(CUSTOM_EMOJI_RE, ':$1:');
  text = text.replace(MENTION_RE, ' ');
  text = text.replace(/@(everyone|here)\b/g, '$1');
  // Line-leading markup: headings, quotes, list bullets.
  text = text.replace(/^[ \t]*(?:#{1,6}|>{1,3}|[-*+]|\d{1,3}\.)[ \t]+/gm, '');
  // Emphasis markers. A lone `_` is left alone — snake_case survives.
  text = text.replace(/\*\*|__|~~|\|\||`|\*/g, '');
  // A markdown escape (`\*`) has lost its subject by now.
  text = text.replace(/\\([*_~`>|[\]()#-])/g, '$1');
  text = text.replace(EMOJI_RE, ' ');
  text = text.replace(CONTROL_RE, ' ');
  // Newlines included: the body must stay one line.
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return '';

  // Escaping before the cap: the escape costs a character, and a cap applied
  // afterwards could cut a `\<` pair in half and leave a dangling escape.
  return capText(escapeMiniMessage(text), cap);
}

/** `...` is ASCII on purpose — the ellipsis glyph is not in the 1.7.10 page. */
function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const cut = text.slice(0, Math.max(1, cap - 3)).trimEnd();
  // Never end on the `\` of a `\<` the slice split.
  return `${cut.replace(/\\$/, '').trimEnd()}...`;
}

/** MiniMessage's literal `<` is `\<`, never `&lt;`. Stray `\` goes first so
 *  the escape can never come out doubled. */
function escapeMiniMessage(text: string): string {
  return text.replace(/\\/g, '').replace(/</g, '\\<');
}

/**
 * The upsert for one post, or `null` when there is nothing worth showing —
 * an image-only post, a sticker, or a message that sanitises down to nothing.
 */
export function buildNoticeDoc(
  src: MirrorSource,
  opts: MirrorOptions,
  now: Date = new Date(),
): MirrorUpsert | null {
  if (!SNOWFLAKE_RE.test(src.messageId)) return null;

  const prefix = sanitisePrefix(opts.prefix);
  const body = sanitiseDiscordText(src.content, Math.max(1, NOTICE_BODY_CAP - prefix.length));
  if (body.length === 0) return null;

  const created = validDate(src.createdAt) ?? now;
  const ttlDays = clamp(opts.ttlDays, 1, 365, 7);
  const author = typeof src.author === 'string' ? src.author.replace(/[^\x20-\x7e]/g, '').slice(0, 48) : '';

  return {
    id: noticeIdFor(src.messageId),
    set: {
      type: 'announcement',
      enabled: true,
      body: { en: `${prefix}${body}` },
      weight: clamp(opts.weight, 1, 10, 1),
      // The window is the POST's, not the mirror's: an edit three days later
      // must not hand a stale announcement another full TTL.
      startsAt: created,
      expiresAt: new Date(created.getTime() + ttlDays * DAY_MS),
      updatedAt: now,
      updatedBy: MIRROR_ACTOR,
      note: author
        ? `Discord #announcements ${src.messageId} by ${author}`
        : `Discord #announcements ${src.messageId}`,
    },
  };
}

/** The prefix is ours, not a player's, but it rides the same card rules. */
/** The prefix is ours, but it is still config: an unbounded one eats the body. */
const PREFIX_CAP = 64;

function sanitisePrefix(prefix: unknown): string {
  if (typeof prefix !== 'string') return '';
  // MiniMessage tags in the prefix are deliberate (`<gray>…</gray>`), so only
  // the newline/control/§ rules apply here.
  const flat = prefix.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ');
  if (flat.trim().length === 0) return '';
  // The trailing space is kept — it separates the prefix from the body.
  return capMiniMessage(flat.trimStart(), PREFIX_CAP);
}

/**
 * Cut without splitting a MiniMessage tag: half of a `<gray>` is not markup,
 * it is a literal `<gra` the parser reads as the start of one and swallows
 * whatever follows.
 */
function capMiniMessage(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  const open = cut.lastIndexOf('<');
  const close = cut.lastIndexOf('>');
  return open > close ? cut.slice(0, open) : cut;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function validDate(value: unknown): Date | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value;
}

/** A deleted post is expired in place — `notices` keeps it listed as evidence. */
export function buildExpiry(now: Date = new Date()): Document {
  return { $set: { expiresAt: now, updatedAt: now, updatedBy: MIRROR_ACTOR, enabled: false } };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** What the mirror needs off a discord.js message (partials included). */
export interface MirrorMessage {
  id?: string | null;
  channelId?: string | null;
  content?: string | null;
  createdAt?: Date | null;
  createdTimestamp?: number | null;
  system?: boolean | null;
  partial?: boolean;
  author?: { username?: string | null } | null;
  fetch?: () => Promise<MirrorMessage>;
}

export interface MirrorConfig extends MirrorOptions {
  channelId: string;
  /** The DB Bifrost's `notices` collection lives in (`MONGODB_DATABASE` there). */
  dbName: string;
}

/** The mongo seam — the tests hand in a recorder instead of a real collection. */
export type CollectionFactory = () => Collection<Document>;

export class AnnouncementsMirror {
  private readonly collection: CollectionFactory;

  constructor(
    private readonly config: MirrorConfig,
    collection?: CollectionFactory,
  ) {
    // Resolved per operation, never pinned: the mongo client is owned by the
    // core and a pinned collection outlives a reconnect.
    this.collection = collection ?? ((): Collection<Document> => getClient().db(this.config.dbName).collection('notices'));
  }

  /** Every handler starts here — an event from any other channel is not ours. */
  private mine(message: MirrorMessage | null | undefined): boolean {
    return !!message && typeof message.id === 'string' && message.channelId === this.config.channelId;
  }

  async onCreate(message: MirrorMessage): Promise<void> {
    await this.upsert(message, 'create');
  }

  /** An edit lands on the same doc — same id, new body. */
  async onUpdate(message: MirrorMessage): Promise<void> {
    await this.upsert(message, 'update');
  }

  async onDelete(message: MirrorMessage): Promise<void> {
    if (!this.mine(message)) return;
    await this.expire(noticeIdFor(message.id as string), 'deleted in Discord');
  }

  /** No upsert, ever: this must not CREATE a notice for a post we skipped. */
  private async expire(id: string, why: string): Promise<void> {
    try {
      const result = await this.collection().updateOne({ id }, buildExpiry());
      if ((result.matchedCount ?? 0) > 0) {
        logger.info({ plugin: 'discord', notice: id, why }, 'Mirrored announcement expired');
      }
    } catch (err) {
      logger.error({ err, plugin: 'discord' }, 'Failed to expire mirrored announcement');
    }
  }

  private async upsert(message: MirrorMessage, via: 'create' | 'update'): Promise<void> {
    try {
      if (!this.mine(message)) return;
      const full = await this.resolve(message);
      if (!full || full.system === true) return;

      const doc = buildNoticeDoc(
        {
          messageId: full.id as string,
          content: full.content ?? '',
          createdAt: full.createdAt ?? (typeof full.createdTimestamp === 'number' ? new Date(full.createdTimestamp) : new Date()),
          author: full.author?.username ?? null,
        },
        this.config,
      );

      // Nothing readable left. On a CREATE that is an image-only post or a
      // sticker: skipped rather than written as an empty card the validator
      // would drop anyway. On an EDIT it is somebody removing the text of a
      // post that IS live, and leaving the old body up until the TTL ran out
      // would be the one thing they were trying to undo — so it expires.
      if (!doc) {
        if (via === 'update') await this.expire(noticeIdFor(full.id as string), 'edited to nothing');
        return;
      }

      // A delete is a tombstone: a create/edit still in flight when it landed —
      // or a re-delivered gateway event — must not put the announcement back in
      // front of every player in game. A pipeline update keeps that decision on
      // the SERVER (a read-then-write would just move the race), and it must
      // stay one statement on `{id}`: filtering the tombstone out instead would
      // make the upsert insert a SECOND doc with the same id.
      const keepDead = { $eq: ['$enabled', false] };
      await this.collection().updateOne(
        { id: doc.id },
        [{
          $set: {
            ...doc.set,
            id: doc.id,
            enabled: { $cond: [keepDead, false, true] },
            expiresAt: { $cond: [keepDead, '$expiresAt', doc.set.expiresAt] },
          },
        }],
        { upsert: true },
      );
      logger.info({ plugin: 'discord', notice: doc.id, via }, 'Mirrored Discord announcement into notices');
    } catch (err) {
      logger.error({ err, plugin: 'discord', via }, 'Failed to mirror Discord announcement');
    }
  }

  /** An edit of an uncached message arrives partial — the content needs a fetch. */
  private async resolve(message: MirrorMessage): Promise<MirrorMessage | null> {
    if (message.partial !== true || typeof message.fetch !== 'function') return message;
    try {
      return await message.fetch();
    } catch (err) {
      logger.warn({ err, plugin: 'discord', message: message.id }, 'Could not fetch partial announcement');
      return null;
    }
  }
}
