import './helpers/env.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Collection, Document } from 'mongodb';

import {
  AnnouncementsMirror,
  MIRROR_ACTOR,
  NOTICE_BODY_CAP,
  buildExpiry,
  buildNoticeDoc,
  noticeIdFor,
  sanitiseDiscordText,
  type MirrorMessage,
} from '../src/plugins/discord/announcements-mirror.ts';
import { configSchema } from '../src/config/schema.ts';

/**
 * The mirror writes into Bifrost's `bifrost.notices`, whose validator lives in
 * that repo (`src/plugins/notices/store.ts`). These are the rules a doc has to
 * pass there, asserted here so a change on this side cannot start writing docs
 * Bifrost silently drops.
 */
const NOTICE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CHANNEL = '111111111111111111';
const OPTS = { prefix: '<gray>[Discord]</gray> ', weight: 3, ttlDays: 7 };
const DAY_MS = 86_400_000;
const NOW = new Date('2026-08-18T12:00:00.000Z');
const POSTED = new Date('2026-08-18T10:00:00.000Z');

// --- sanitise ---------------------------------------------------------------

test('sanitise: discord markdown comes out as plain text', () => {
  assert.equal(sanitiseDiscordText('**Bold** and *italic* and __under__ and ~~gone~~'), 'Bold and italic and under and gone');
  assert.equal(sanitiseDiscordText('# Heading\n> quoted\n- bullet'), 'Heading quoted bullet');
  assert.equal(sanitiseDiscordText('run `/help` now'), 'run /help now');
  assert.equal(sanitiseDiscordText('```js\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(sanitiseDiscordText('||spoiler||'), 'spoiler');
  assert.equal(sanitiseDiscordText('a \\*literal\\* star'), 'a literal star');
  // A link is usually the point of an announcement, so the URL is kept.
  assert.equal(sanitiseDiscordText('[downloads](https://valhallamc.io/downloads)'), 'downloads (https://valhallamc.io/downloads)');
  // snake_case must survive — only doubled underscores are markup.
  assert.equal(sanitiseDiscordText('use pack_mode please'), 'use pack_mode please');
});

test('sanitise: mentions and emoji ids lose their ids', () => {
  assert.equal(sanitiseDiscordText('hey <@123456789> and <@!987654321> and <@&555>'), 'hey and and');
  assert.equal(sanitiseDiscordText('see <#111222333> for more'), 'see for more');
  assert.equal(sanitiseDiscordText('nice <:pog:123456789012345678> job'), 'nice :pog: job');
  assert.equal(sanitiseDiscordText('at <t:1700000000:R> we restart'), 'at we restart');
  assert.equal(sanitiseDiscordText('@everyone new pack!'), 'everyone new pack!');
  // A 1.7.10 client draws a box for every one of these.
  assert.equal(sanitiseDiscordText('Server is up 🎉🇬🇧'), 'Server is up');
});

test('sanitise: § and control characters never reach a chat card', () => {
  assert.equal(sanitiseDiscordText('red §cnot§r any more'), 'red cnot r any more');
  assert.equal(sanitiseDiscordText('ab​c'), 'a b c');
});

test('sanitise: newlines collapse to spaces (a newline splits a 1.7.10 card)', () => {
  const out = sanitiseDiscordText('line one\nline two\r\n\r\nline three');
  assert.equal(out, 'line one line two line three');
  assert.equal(out.includes('\n'), false);
});

test('sanitise: a literal < is escaped MiniMessage-style, never &lt;', () => {
  assert.equal(sanitiseDiscordText('tps < 15 on <red>'), 'tps \\< 15 on \\<red>');
  assert.equal(sanitiseDiscordText('a <b').includes('&lt;'), false);
});

test('sanitise: over-long text is cut to the cap with an ASCII ellipsis', () => {
  const out = sanitiseDiscordText('x'.repeat(NOTICE_BODY_CAP + 200));
  assert.equal(out.length, NOTICE_BODY_CAP);
  assert.equal(out.endsWith('...'), true);
  // A cut must never leave the `\` of a `\<` dangling.
  const escaped = sanitiseDiscordText(`${'y'.repeat(NOTICE_BODY_CAP - 4)}<tail`);
  assert.equal(/\\\.\.\.$/.test(escaped), false);
  assert.equal(escaped.length <= NOTICE_BODY_CAP, true);
});

test('sanitise: nothing readable left is the empty string (an image-only post)', () => {
  for (const raw of ['', '   ', '\n\n', '🎉', '<@123>', '**__**', null, undefined, 42]) {
    assert.equal(sanitiseDiscordText(raw), '', JSON.stringify(raw));
  }
});

// --- buildNoticeDoc ---------------------------------------------------------

test('build: the doc is an announcement Bifrost validates as-is', () => {
  const built = buildNoticeDoc({ messageId: '900000000000000001', content: 'Pack update **today**', createdAt: POSTED, author: 'Alp' }, OPTS, NOW);
  assert.ok(built);
  assert.equal(built.id, 'announcement.discord.900000000000000001');
  assert.match(built.id, NOTICE_ID_RE);
  assert.equal(built.id.length <= 128, true);
  assert.equal(built.set.type, 'announcement');
  assert.equal(built.set.enabled, true);
  assert.equal(built.set.body.en, '<gray>[Discord]</gray> Pack update today');
  assert.equal(built.set.weight, 3);
  assert.equal(built.set.updatedBy, MIRROR_ACTOR);
  assert.deepEqual(built.set.startsAt, POSTED);
  assert.equal(built.set.body.en.includes('\n'), false);
  assert.equal(built.set.body.en.length <= NOTICE_BODY_CAP, true);
});

test('build: the TTL runs from the POST, so an edit cannot renew a stale announcement', () => {
  const built = buildNoticeDoc({ messageId: '900000000000000001', content: 'hello', createdAt: POSTED }, OPTS, NOW);
  assert.equal(built!.set.expiresAt.getTime(), POSTED.getTime() + 7 * DAY_MS);
  // Same post, mirrored a week later by an edit: the window has not moved.
  const later = buildNoticeDoc({ messageId: '900000000000000001', content: 'hello (edited)', createdAt: POSTED }, OPTS, new Date(NOW.getTime() + 6 * DAY_MS));
  assert.equal(later!.set.expiresAt.getTime(), built!.set.expiresAt.getTime());
});

test('build: weight and ttl are clamped, a junk value falls back', () => {
  const wide = buildNoticeDoc({ messageId: '1', content: 'hi', createdAt: POSTED }, { ...OPTS, weight: 99, ttlDays: 0 }, NOW);
  assert.equal(wide!.set.weight, 10);
  assert.equal(wide!.set.expiresAt.getTime(), POSTED.getTime() + DAY_MS);
  const junk = buildNoticeDoc({ messageId: '1', content: 'hi', createdAt: POSTED }, { ...OPTS, weight: Number.NaN, ttlDays: Number.NaN }, NOW);
  assert.equal(junk!.set.weight, 1);
  assert.equal(junk!.set.expiresAt.getTime(), POSTED.getTime() + 7 * DAY_MS);
});

test('build: prefix + body stay inside the body cap together', () => {
  const built = buildNoticeDoc({ messageId: '1', content: 'z'.repeat(600), createdAt: POSTED }, OPTS, NOW);
  assert.equal(built!.set.body.en.length <= NOTICE_BODY_CAP, true);
  assert.equal(built!.set.body.en.startsWith('<gray>[Discord]</gray> '), true);
});

test('build: an empty post and a bogus message id build nothing', () => {
  assert.equal(buildNoticeDoc({ messageId: '900000000000000001', content: '  🎉 ', createdAt: POSTED }, OPTS, NOW), null);
  assert.equal(buildNoticeDoc({ messageId: 'not-a-snowflake', content: 'hello', createdAt: POSTED }, OPTS, NOW), null);
});

test('expiry: the delete update only touches the window and the author', () => {
  const update = buildExpiry(NOW) as { $set: Record<string, unknown> };
  assert.deepEqual(Object.keys(update.$set).sort(), ['expiresAt', 'updatedAt', 'updatedBy']);
  assert.equal((update.$set.expiresAt as Date).getTime(), NOW.getTime());
});

// --- the runtime handlers ---------------------------------------------------

interface Recorded {
  filter: Document;
  update: Document;
  upsert: boolean;
}

/** A stand-in for `bifrost.notices`: applies the update the way Mongo would. */
function fakeCollection(): { coll: Collection<Document>; docs: Map<string, Document>; calls: Recorded[] } {
  const docs = new Map<string, Document>();
  const calls: Recorded[] = [];
  const coll = {
    updateOne(filter: Document, update: Document, options?: { upsert?: boolean }) {
      const upsert = options?.upsert === true;
      calls.push({ filter, update, upsert });
      const id = filter.id as string;
      const existing = docs.get(id);
      if (!existing && !upsert) return Promise.resolve({ matchedCount: 0, upsertedCount: 0 });
      const next = { ...(existing ?? {}), ...((update.$setOnInsert as Document) ?? {}), ...((update.$set as Document) ?? {}) };
      docs.set(id, next);
      return Promise.resolve({ matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 });
    },
  } as unknown as Collection<Document>;
  return { coll, docs, calls };
}

function mirrorWith(): ReturnType<typeof fakeCollection> & { mirror: AnnouncementsMirror } {
  const fake = fakeCollection();
  const mirror = new AnnouncementsMirror({ channelId: CHANNEL, dbName: 'bifrost', ...OPTS }, () => fake.coll);
  return { ...fake, mirror };
}

function message(overrides: Partial<MirrorMessage> = {}): MirrorMessage {
  return { id: '900000000000000001', channelId: CHANNEL, content: 'Server is up', createdAt: POSTED, ...overrides };
}

test('mirror: the same message delivered twice is one doc, keyed by the message id', async () => {
  const { mirror, docs, calls } = mirrorWith();
  await mirror.onCreate(message());
  await mirror.onCreate(message()); // restart / gateway re-delivery
  assert.equal(docs.size, 1);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.filter, { id: noticeIdFor('900000000000000001') });
    assert.equal(call.upsert, true);
    assert.deepEqual((call.update.$setOnInsert as Document).id, 'announcement.discord.900000000000000001');
  }
});

test('mirror: an edit updates the same doc instead of adding a second one', async () => {
  const { mirror, docs } = mirrorWith();
  await mirror.onCreate(message());
  await mirror.onUpdate(message({ content: 'Server is up **again**' }));
  assert.equal(docs.size, 1);
  const doc = docs.get('announcement.discord.900000000000000001')!;
  assert.equal((doc.body as { en: string }).en, '<gray>[Discord]</gray> Server is up again');
  assert.equal(doc.enabled, true);
});

test('mirror: a deleted message expires its doc rather than deleting it', async () => {
  const { mirror, docs, calls } = mirrorWith();
  await mirror.onCreate(message());
  await mirror.onDelete(message());
  const doc = docs.get('announcement.discord.900000000000000001')!;
  assert.equal(doc.expiresAt instanceof Date, true);
  assert.equal((doc.expiresAt as Date).getTime() <= Date.now(), true);
  assert.equal(docs.size, 1, 'expired, never removed — notices keeps it as evidence');
  assert.equal(calls.at(-1)!.upsert, false, 'a delete must not create a notice for a post we skipped');
});

test('mirror: deleting a message that was never mirrored writes nothing', async () => {
  const { mirror, docs } = mirrorWith();
  await mirror.onDelete(message({ id: '900000000000000009' }));
  assert.equal(docs.size, 0);
});

test('mirror: another channel and an unreadable post are both no-ops', async () => {
  const { mirror, docs } = mirrorWith();
  await mirror.onCreate(message({ channelId: '222222222222222222' }));
  await mirror.onUpdate(message({ channelId: '222222222222222222' }));
  await mirror.onDelete(message({ channelId: '222222222222222222' }));
  await mirror.onCreate(message({ content: '🎉' }));       // image/emoji-only post
  await mirror.onCreate(message({ system: true }));         // pin/join system message
  assert.equal(docs.size, 0);
});

test('mirror: a partial edit is fetched before it is mirrored', async () => {
  const { mirror, docs } = mirrorWith();
  await mirror.onUpdate({
    id: '900000000000000001',
    channelId: CHANNEL,
    partial: true,
    fetch: () => Promise.resolve(message({ content: 'fetched body' })),
  });
  assert.equal((docs.get('announcement.discord.900000000000000001')!.body as { en: string }).en, '<gray>[Discord]</gray> fetched body');
});

test('mirror: a mongo failure is logged, never thrown at the gateway handler', async () => {
  const boom = { updateOne: () => Promise.reject(new Error('no primary')) } as unknown as Collection<Document>;
  const mirror = new AnnouncementsMirror({ channelId: CHANNEL, dbName: 'bifrost', ...OPTS }, () => boom);
  await mirror.onCreate(message());
  await mirror.onUpdate(message());
  await mirror.onDelete(message());
});

test('mirror: a fetch that throws drops the event instead of the process', async () => {
  const { mirror, docs } = mirrorWith();
  await mirror.onUpdate({
    id: '900000000000000001',
    channelId: CHANNEL,
    partial: true,
    fetch: () => Promise.reject(new Error('unknown message')),
  });
  assert.equal(docs.size, 0);
});

// --- config -----------------------------------------------------------------

const baseEnv = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  MONGODB_DB_NAME: 'ygg_test',
  JWT_SECRET: 'x'.repeat(32),
};

test('config: the mirror is off by default and needs nothing configured', () => {
  const parsed = configSchema.safeParse(baseEnv);
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.ANNOUNCEMENTS_MIRROR_ENABLED, false);
  assert.equal(parsed.success && parsed.data.ANNOUNCEMENTS_MIRROR_TTL_DAYS, 7);
  assert.equal(parsed.success && parsed.data.ANNOUNCEMENTS_MIRROR_WEIGHT, 1);
  assert.equal(parsed.success && parsed.data.ANNOUNCEMENTS_MIRROR_DB_NAME, 'bifrost');
});

test('config: enabling the mirror requires the discord plugin and a channel', () => {
  const missing = configSchema.safeParse({ ...baseEnv, ANNOUNCEMENTS_MIRROR_ENABLED: 'true' });
  assert.equal(missing.success, false);
  assert.deepEqual(
    missing.success ? [] : missing.error.issues.map((i) => i.path.join('.')).sort(),
    ['ANNOUNCEMENTS_MIRROR_CHANNEL_ID', 'PLUGIN_DISCORD'],
  );
  const ok = configSchema.safeParse({
    ...baseEnv,
    PLUGIN_DISCORD: 'true',
    ANNOUNCEMENTS_MIRROR_ENABLED: 'true',
    ANNOUNCEMENTS_MIRROR_CHANNEL_ID: CHANNEL,
  });
  assert.equal(ok.success, true);
});
