#!/usr/bin/env node
/**
 * Upload a pack's item icons and/or `en_us` lang map to Yggdrasil (phase 8 icon pipeline).
 *
 * Icons and quest/item lang are dumped CLIENT-side, once per pack version, on the operator's
 * machine (no exporter mod runs on prod). This pushes those dumps over the auditable REST API
 * instead of a shell `mongoimport` on the prod box.
 *
 *   Icons:  a directory of PNGs named by item id. The base name is the id with ':' / '/'
 *           replaced by '__' (and an optional '@<meta>' or '__<meta>' suffix for legacy metas):
 *             minecraft__stone.png            → minecraft:stone
 *             gregtech__gt.metaitem.01@32001  → gregtech:gt.metaitem.01:32001
 *   Lang:   a JSON object { "<key>": "<value>", ... } (e.g. a pack's en_us.json), or a MC
 *           `.lang` file (key=value lines). Resolves lang-key quest/item titles at the next dump.
 *
 * Usage:
 *   YGG_URL=http://127.0.0.1:3123 YGG_API_KEY=<key> \
 *     node scripts/upload-icons.mjs --pack <pack> [--icons <dir>] [--lang <file>] [--dry]
 *
 * `--pack` is the pack key (== the server tag in this network). Icons POST in batches of 200.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const pack = flag('--pack');
const iconsDir = flag('--icons');
const langFile = flag('--lang');
const dry = args.includes('--dry');
const base = (process.env.YGG_URL ?? 'http://127.0.0.1:3123').replace(/\/$/, '');
const apiKey = process.env.YGG_API_KEY ?? process.env.API_KEYS?.split(',')[0];
const BATCH = 200;

if (!pack || (!iconsDir && !langFile)) {
  console.error('usage: --pack <pack> [--icons <dir>] [--lang <file>] [--dry]  (env: YGG_URL, YGG_API_KEY)');
  process.exit(2);
}
if (!apiKey) {
  console.error('missing YGG_API_KEY (or API_KEYS)');
  process.exit(2);
}

async function api(method, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** filename (without .png) → item id. `__` → ':' for the namespace colon, then '/' stays. */
function idFromFilename(name) {
  let base = name.replace(/\.png$/i, '');
  // legacy meta suffix: `@N` or a trailing `__N` where N is all digits
  let meta = null;
  const at = base.match(/@(\d+)$/);
  if (at) {
    meta = at[1];
    base = base.slice(0, -at[0].length);
  }
  // first `__` is the namespace separator → ':'
  const sep = base.indexOf('__');
  let id = sep >= 0 ? `${base.slice(0, sep)}:${base.slice(sep + 2)}` : base;
  if (meta !== null) id = `${id}:${meta}`;
  return id;
}

async function uploadLang() {
  const raw = await readFile(langFile, 'utf8');
  let lang;
  if (langFile.endsWith('.json')) {
    lang = JSON.parse(raw);
  } else {
    // MC .lang: key=value lines, skip comments/blanks
    lang = {};
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0) lang[t.slice(0, eq)] = t.slice(eq + 1);
    }
  }
  const entries = Object.keys(lang).length;
  console.log(`[lang] ${entries} entries from ${path.basename(langFile)}`);
  if (dry) return;
  const out = await api('PUT', `/v1/biforesting/packs/${encodeURIComponent(pack)}/lang`, { lang });
  console.log(`[lang] stored ${out.data?.entries} entries for pack "${pack}"`);
}

async function uploadIcons() {
  const files = (await readdir(iconsDir)).filter((f) => f.toLowerCase().endsWith('.png'));
  console.log(`[icons] ${files.length} PNGs in ${iconsDir}`);
  let stored = 0;
  let deduped = 0;
  let mapped = 0;
  for (let i = 0; i < files.length; i += BATCH) {
    const slice = files.slice(i, i + BATCH);
    const icons = [];
    for (const f of slice) {
      const buf = await readFile(path.join(iconsDir, f));
      icons.push({ id: idFromFilename(f), pngBase64: buf.toString('base64') });
    }
    if (dry) {
      console.log(`[icons] (dry) batch ${i / BATCH + 1}: ${icons.length} icons, e.g. ${icons[0].id}`);
      continue;
    }
    const out = await api('POST', `/v1/biforesting/packs/${encodeURIComponent(pack)}/icons`, { icons });
    stored += out.data?.stored ?? 0;
    deduped += out.data?.deduped ?? 0;
    mapped += out.data?.mapped ?? 0;
    process.stdout.write(`\r[icons] ${Math.min(i + BATCH, files.length)}/${files.length} mapped=${mapped} stored=${stored} deduped=${deduped}`);
  }
  if (!dry) console.log(`\n[icons] done: mapped=${mapped} stored=${stored} deduped=${deduped}`);
}

async function main() {
  if (langFile) {
    const s = await stat(langFile).catch(() => null);
    if (!s) throw new Error(`lang file not found: ${langFile}`);
    await uploadLang();
  }
  if (iconsDir) {
    const s = await stat(iconsDir).catch(() => null);
    if (!s?.isDirectory()) throw new Error(`icons dir not found: ${iconsDir}`);
    await uploadIcons();
  }
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
