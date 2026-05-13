/**
 * One-time migration: rename player_sessions.server and player_stats_history.source
 * from server NAMES to server TAGS so analytics queries work after Bifrost switches
 * to sending tags.
 *
 * Usage:
 *   npx tsx src/scripts/migrate-server-names-to-tags.ts           # dry-run (report only)
 *   npx tsx src/scripts/migrate-server-names-to-tags.ts --apply   # execute migration
 */

// @ts-nocheck
import { MongoClient } from 'mongodb';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}
const YGGDRASIL_DB = 'yggdrasil';
const BIFROST_DB = 'bifrost';
const BACKUP_DIR = './backup-before-tag-migration';

const apply = process.argv.includes('--apply');

// Manual mapping for names that no longer exist in bifrost.servers
// (old renames, extra whitespace from Bifrost bugs, defunct servers)
const MANUAL_MAP: Record<string, string> = {
  'Arcadia   [RPG]': 'arc',
  'StoneBlock  3': 'sb3',
  'Project  Infinity 0.1': 'pri',
  'Technological Journey   ': 'tj',
  'Dimensional Ascension ': 'da',
  'Enigmatica 2: Expert ': 'e2e',
  'FTB StoneBlock 4B ': 'sb4b',
  'Legendary Edition ': 'lg',
  'MeatballCraft Dimensional As. ': 'mbc',
  'Nomifactory (GTCEu Port)': 'nfu',
  'Nomifactory    (GTCEu Port)': 'nfu',
  'Picky ': 'pc',
  'Star Technology ': 'star',
  'GT Odyssey [Hard]': 'gto',
  'Development server': 'dev',
  'Bifrost 1.12.2 Server :D': 'bif',
  'Bifrost 1.21.1 Server :D': 'bif',
  'Bifrost 1.7.10 Server :D': 'bif',
  'Bifrost 1.7.10 gtnh :D': 'bif',
  'Bifrost HUB Server :D': 'bif',
  'All the Mods 9 - To the Sky': 'atm9s',
  'Concatenation': 'ctn',
  'Create: Industrialized Tech': 'cit',
  'FTB StoneBlock 4B': 'sb4b',
  'Dimensional Ascension': 'da',
  'Antimatter Chemistry': 'ac',
  'Project Ozone 3 [Normal]': 'po3',
  'Bifrost Server :D': 'bif',
  'Picky': 'pc',
};

async function main(): Promise<void> {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log('Connected to MongoDB');

    // ── Build name→tag mapping from bifrost.servers ──────────────────
    const bifrostDb = client.db(BIFROST_DB);
    const servers = await bifrostDb.collection('servers').find({}, { projection: { name: 1, tag: 1 } }).toArray();

    const nameToTag = new Map<string, string>();

    for (const s of servers) {
      const name = s.name as string;
      const tag = s.tag as string;
      if (name && tag) nameToTag.set(name, tag);
    }

    for (const [name, tag] of Object.entries(MANUAL_MAP)) {
      if (!nameToTag.has(name)) nameToTag.set(name, tag);
    }

    console.log(`\nBuilt mapping: ${nameToTag.size} name→tag entries`);

    const yggDb = client.db(YGGDRASIL_DB);
    const sessions = yggDb.collection('player_sessions');
    const statsHistory = yggDb.collection('player_stats_history');

    // ── Discover what needs migrating ────────────────────────────────
    const sessionServers = await sessions.distinct('server');
    const histSources = await statsHistory.distinct('source');

    // Values already equal to a tag (or "global") need no migration
    const allTags = new Set(servers.map((s) => s.tag as string));
    allTags.add('global');

    const sessionMappings: Array<{ from: string; to: string }> = [];
    const histMappings: Array<{ from: string; to: string }> = [];
    const unmappedSessions: string[] = [];
    const unmappedHist: string[] = [];

    for (const name of sessionServers) {
      if (allTags.has(name)) continue; // already a tag
      const tag = nameToTag.get(name);
      if (tag) sessionMappings.push({ from: name, to: tag });
      else unmappedSessions.push(name);
    }

    for (const name of histSources) {
      if (allTags.has(name)) continue;
      const tag = nameToTag.get(name);
      if (tag) histMappings.push({ from: name, to: tag });
      else unmappedHist.push(name);
    }

    // ── Dry-run report ───────────────────────────────────────────────
    console.log('\n── player_sessions migration ──');
    for (const m of sessionMappings) {
      const count = await sessions.countDocuments({ server: m.from });
      console.log(`  "${m.from}" → "${m.to}"  (${count} docs)`);
    }
    if (unmappedSessions.length > 0) {
      console.log(`  UNMAPPED: ${JSON.stringify(unmappedSessions)}`);
    }

    console.log('\n── player_stats_history migration ──');
    for (const m of histMappings) {
      const count = await statsHistory.countDocuments({ source: m.from });
      console.log(`  "${m.from}" → "${m.to}"  (${count} docs)`);
    }
    if (unmappedHist.length > 0) {
      console.log(`  UNMAPPED: ${JSON.stringify(unmappedHist)}`);
    }

    if (!apply) {
      console.log('\n✓ DRY RUN complete. Pass --apply to execute the migration.');
      return;
    }

    // ── Backup (clone collections server-side) ─────────────────────
    console.log('\n── Creating backup ──');
    const yggBackupSessions = yggDb.collection('player_sessions_backup_pretag');
    const yggBackupHistory = yggDb.collection('player_stats_history_backup_pretag');

    const sessionsBackupExists = await yggBackupSessions.countDocuments({}, { limit: 1 });
    const historyBackupExists = await yggBackupHistory.countDocuments({}, { limit: 1 });

    if (sessionsBackupExists > 0 || historyBackupExists > 0) {
      console.log('  Backup collections already exist, skipping.');
    } else {
      console.log('  Cloning player_sessions → player_sessions_backup_pretag...');
      await sessions.aggregate([{ $out: 'player_sessions_backup_pretag' }]).toArray();
      console.log('  Cloning player_stats_history → player_stats_history_backup_pretag...');
      await statsHistory.aggregate([{ $out: 'player_stats_history_backup_pretag' }]).toArray();
      console.log('  Backup complete.');
    }

    // ── Execute ──────────────────────────────────────────────────────
    console.log('\n── Applying migrations ──');

    for (const m of sessionMappings) {
      const result = await sessions.updateMany({ server: m.from }, { $set: { server: m.to } });
      console.log(`  sessions: "${m.from}" → "${m.to}"  (${result.modifiedCount} modified)`);
    }

    for (const m of histMappings) {
      const result = await statsHistory.updateMany({ source: m.from }, { $set: { source: m.to } });
      console.log(`  stats_history: "${m.from}" → "${m.to}"  (${result.modifiedCount} modified)`);
    }

    // ── Verify ───────────────────────────────────────────────────────
    console.log('\n── Verification ──');
    const remainingSessions = await sessions.distinct('server');
    const remainingHist = await statsHistory.distinct('source');
    const nonTagSessions = remainingSessions.filter((s) => !allTags.has(s));
    const nonTagHist = remainingHist.filter((s) => !allTags.has(s));

    if (nonTagSessions.length === 0 && nonTagHist.length === 0) {
      console.log('✓ All values are now tags. Migration complete.');
    } else {
      if (nonTagSessions.length > 0) console.log(`  Remaining non-tag session servers: ${JSON.stringify(nonTagSessions)}`);
      if (nonTagHist.length > 0) console.log(`  Remaining non-tag history sources: ${JSON.stringify(nonTagHist)}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
