#!/usr/bin/env node
/**
 * Certificate manifest generator.
 *
 * Scans images/certificates/ and writes images/certificates/certificates.json,
 * which the gallery (certificates.js) reads in the browser. A static site cannot
 * list a server folder at runtime, so the listing is produced at build time.
 *
 * No dependencies. Node 18+.
 *
 *   node scripts/generate-certificates.mjs            write the manifest
 *   node scripts/generate-certificates.mjs --check    exit 1 if the manifest is stale
 *   node scripts/generate-certificates.mjs --dir <d> --out <file> --base <url-prefix>
 *
 * Rules
 *   - Included: .jpg .jpeg .png .webp (any letter case) that are readable images.
 *   - Ignored: hidden files, directories, symlinks, unsupported extensions,
 *     temporary files, and the manifest / metadata files themselves.
 *   - Skipped with a reason (listed under "skipped"): truncated or unreadable images.
 *   - Output is deterministic (no timestamps) so an unchanged folder never
 *     produces a changed file.
 *
 * Optional titles: add images/certificates/certificates.meta.json
 *   { "file-name.jpg": { "title": "...", "issuer": "...", "date": "2024" } }
 * Anything not listed there gets a neutral label derived from the file name.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MANIFEST_NAME = 'certificates.json';
export const META_NAME = 'certificates.meta.json';
export const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_BYTES = 25 * 1024 * 1024;
const WARN_BYTES = 1.5 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Image parsing: dimensions plus a structural integrity check         */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** PNG is checked end to end: header, every chunk checksum, and the pixel stream. */
function parsePng(b) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33 || SIG.some((v, i) => b[i] !== v)) throw new Error('not a PNG');
  if (b.toString('latin1', 12, 16) !== 'IHDR') throw new Error('PNG header missing');
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const depth = b[24], color = b[25], interlace = b[28];
  if (!(PNG_DEPTHS[color] || []).includes(depth) || b[26] !== 0 || b[27] !== 0 || interlace > 1) {
    throw new Error('PNG header is invalid');
  }
  let off = 8, iend = false;
  const idat = [];
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    const next = off + 12 + len;
    if (next > b.length) throw new Error('PNG is truncated');
    if (b.readUInt32BE(off + 8 + len) !== crc32(b, off + 4, off + 8 + len)) throw new Error('PNG is corrupt (checksum mismatch)');
    if (type === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') { iend = true; break; }
    off = next;
  }
  if (!idat.length) throw new Error('PNG has no image data');
  if (!iend) throw new Error('PNG is truncated (no end chunk)');
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { throw new Error('PNG image data is corrupt'); }
  if (!interlace) {
    const rowBytes = Math.ceil((width * PNG_CHANNELS[color] * depth) / 8);
    if (raw.length < height * (rowBytes + 1)) throw new Error('PNG image data is incomplete');
  }
  return { format: 'png', width, height, orientation: 1 };
}

function readExifOrientation(t) {
  try {
    const le = t.toString('latin1', 0, 2) === 'II';
    const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
    const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    if (u16(2) !== 42) return 1;
    const ifd = u32(4);
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === 0x0112) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
  } catch { /* malformed EXIF is not an error */ }
  return 1;
}

function parseJpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG');
  let off = 2, width = 0, height = 0, orientation = 1, sof = false;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) { off++; continue; }
    const m = b[off + 1];
    if (m === 0xff) { off++; continue; }
    if (m === 0x00 || m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { off += 2; continue; }
    if (m === 0xd9) break;
    const len = b.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > b.length) throw new Error('JPEG is truncated');
    if (m === 0xe1 && b.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
      orientation = readExifOrientation(b.subarray(off + 10, off + 2 + len));
    }
    if (!sof && m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      height = b.readUInt16BE(off + 5);
      width = b.readUInt16BE(off + 7);
      sof = true;
    }
    if (m === 0xda) break; // entropy-coded data follows
    off += 2 + len;
  }
  if (!sof || !width || !height) throw new Error('JPEG has no frame header');
  let end = b.length;
  while (end > 2 && b[end - 1] === 0) end--; // tolerate zero padding
  if (!(b[end - 2] === 0xff && b[end - 1] === 0xd9)) throw new Error('JPEG is truncated (no end marker)');
  return { format: 'jpeg', width, height, orientation };
}

function parseWebp(b) {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') {
    throw new Error('not a WebP');
  }
  if (b.readUInt32LE(4) + 8 > b.length) throw new Error('WebP is truncated');
  const kind = b.toString('latin1', 12, 16);
  let width, height;
  if (kind === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) throw new Error('WebP frame header invalid');
    width = b.readUInt16LE(26) & 0x3fff;
    height = b.readUInt16LE(28) & 0x3fff;
  } else if (kind === 'VP8L') {
    if (b[20] !== 0x2f) throw new Error('WebP frame header invalid');
    const bits = b.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (kind === 'VP8X') {
    width = 1 + b.readUIntLE(24, 3);
    height = 1 + b.readUIntLE(27, 3);
  } else {
    throw new Error('unknown WebP type');
  }
  if (!width || !height) throw new Error('WebP has no dimensions');
  return { format: 'webp', width, height, orientation: 1 };
}

/** Detects the real format from content (not the extension) and validates it. */
export function parseImage(buf) {
  let info;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) info = parsePng(buf);
  else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) info = parseJpeg(buf);
  else if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF') info = parseWebp(buf);
  else throw new Error('unrecognised or unreadable image data');
  if (info.width < 1 || info.height < 1 || info.width > 30000 || info.height > 30000) {
    throw new Error('implausible image dimensions');
  }
  // EXIF orientations 5-8 are rotated by browsers, so swap to the displayed size.
  if (info.orientation >= 5) [info.width, info.height] = [info.height, info.width];
  delete info.orientation;
  return info;
}

/* ------------------------------------------------------------------ */
/* Display names                                                       */
/* ------------------------------------------------------------------ */

const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'for', 'in', 'on', 'to', 'at', 'by', 'with', 'from', 'as', 'vs']);
const ACRONYMS = new Map(Object.entries({
  sap: 'SAP', aws: 'AWS', ai: 'AI', ml: 'ML', iot: 'IoT', mcp: 'MCP', sql: 'SQL', api: 'API',
  ui: 'UI', ux: 'UX', ieee: 'IEEE', html: 'HTML', css: 'CSS', js: 'JS', llm: 'LLM', llms: 'LLMs',
  mba: 'MBA', hr: 'HR', ece: 'ECE'
}));
const GENERIC_WORDS = [
  'img', 'image', 'images', 'photo', 'photos', 'pic', 'pics', 'picture', 'pictures', 'map', 'scan', 'scanned',
  'screenshot', 'screen shot', 'capture', 'dsc', 'dscn', 'dscf', 'pxl', 'mvimg', 'file', 'files', 'document',
  'doc', 'untitled', 'unnamed', 'unknown', 'download', 'new', 'copy', 'whatsapp image', 'whatsapp', 'jpeg', 'jpg', 'png', 'webp'
];
const GENERIC_RE = new RegExp(`^(?:${GENERIC_WORDS.join('|')})(?:[\\s\\d]|\\b(?:at|am|pm|copy)\\b)*$`, 'i');
const CERT_GENERIC_RE = /^(?:certificate|certificates|cert)\s*(\d{1,3})?$/i;

// Control, zero-width and bidi characters are never shown.
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

function cleanName(fileName) {
  let base = fileName.normalize('NFC');
  const dot = base.lastIndexOf('.');
  if (dot > 0 && SUPPORTED_EXT.has(base.slice(dot).toLowerCase())) base = base.slice(0, dot);
  return base
    .replace(INVISIBLE_RE, '')
    .replace(/[_\-.\u2010-\u2015+]+/g, ' ')
    .replace(/\s*\(\d+\)\s*$/, '')          // "name (1)" download duplicates
    .replace(/\s+copy(\s+\d+)?\s*$/i, '')   // "name copy 2"
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCaseWord(word, isFirst) {
  const lower = word.toLowerCase();
  if (ACRONYMS.has(lower)) return ACRONYMS.get(lower);
  if (/^\d/.test(word)) return word;
  const hasInnerUpper = /\p{Lu}/u.test(word.slice(1));
  if (hasInnerUpper && !(word === word.toUpperCase() && word.length > 4)) return word; // keep "eBPF", "GitHub"
  if (!isFirst && SMALL_WORDS.has(lower)) return lower;
  const chars = Array.from(lower);
  return chars[0].toLocaleUpperCase('en') + chars.slice(1).join('');
}

/**
 * Returns { kind: 'named' | 'generic', title?, number? } for a file name.
 * 'generic' names (map01, IMG_2024..., image001) get a neutral "Certificate NN"
 * label assigned later; named files are only reformatted, never reworded.
 */
export function describeName(fileName) {
  const name = cleanName(fileName);
  if (!name) return { kind: 'generic', number: null };
  const lower = name.toLowerCase();
  const cert = CERT_GENERIC_RE.exec(name);
  if (cert) return { kind: 'generic', number: cert[1] ? Number(cert[1]) : null };
  if (/^[\d\s]+$/.test(name) || GENERIC_RE.test(lower)) {
    const run = /\d+/.exec(name);
    const number = run && run[0].length <= 3 && Number(run[0]) > 0 ? Number(run[0]) : null;
    return { kind: 'generic', number };
  }
  const words = name.split(' ');
  return { kind: 'named', title: words.map((w, i) => titleCaseWord(w, i === 0)).join(' ') };
}

/** Convenience wrapper for single-file use and tests. */
export function makeTitle(fileName) {
  const d = describeName(fileName);
  if (d.kind === 'named') return d.title;
  return `Certificate ${String(d.number ?? 1).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Directory scan                                                      */
/* ------------------------------------------------------------------ */

const TEMP_RE = /(^~|~$|^\.#|\.(tmp|temp|part|partial|crdownload|download|swp|swo|bak|orig)$|^thumbs\.db$|^desktop\.ini$)/i;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

const encodePath = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const sha1 = (data) => createHash('sha1').update(data).digest('hex');
const clip = (v, n, allowNumber = false) => {
  if (allowNumber && typeof v === 'number' && Number.isFinite(v)) v = String(v);
  return typeof v === 'string' ? v.replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim().slice(0, n) : '';
};

async function loadMeta(dir) {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, META_NAME), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

export async function buildManifest({ dir, base = 'images/certificates', warn = () => {} }) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    warn(`folder not found: ${dir}`);
  }
  const meta = await loadMeta(dir);
  // Keys match the file name exactly, or ignoring letter case and Unicode form
  // (macOS stores accented names decomposed, editors usually type them composed).
  const metaIndex = new Map();
  for (const [k, v] of Object.entries(meta)) metaIndex.set(k.normalize('NFC').toLowerCase(), v);
  const metaFor = (file) => {
    const v = Object.prototype.hasOwnProperty.call(meta, file) ? meta[file] : metaIndex.get(file.normalize('NFC').toLowerCase());
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  };

  const candidates = [];
  for (const ent of entries) {
    const n = ent.name;
    if (n === MANIFEST_NAME || n === META_NAME) continue;
    if (!ent.isFile()) continue;                       // directories, symlinks, sockets
    if (n.startsWith('.')) continue;                   // hidden files
    if (TEMP_RE.test(n)) continue;                     // temporary / partial files
    if (!SUPPORTED_EXT.has(path.extname(n).toLowerCase())) continue;
    candidates.push(n);
  }
  candidates.sort(byName);

  const good = [];
  const skipped = [];
  for (const file of candidates) {
    try {
      const buf = await readFile(path.join(dir, file));
      if (buf.length === 0) throw new Error('file is empty');
      if (buf.length > MAX_BYTES) throw new Error('file is larger than 25 MB');
      const info = parseImage(buf);
      if (buf.length > WARN_BYTES) warn(`${file} is ${(buf.length / 1048576).toFixed(1)} MB. Consider optimising it; the gallery loads the original file.`);
      good.push({ file, info, bytes: buf.length, v: sha1(buf).slice(0, 8) });
    } catch (e) {
      skipped.push({ file, reason: e.message });
      warn(`skipped ${file}: ${e.message}`);
    }
  }

  // Titles: metadata > formatted file name > neutral numbered label.
  const used = new Set();
  const described = good.map((g) => ({ g, d: describeName(g.file) }));
  const taken = new Set();
  for (const { d } of described) if (d.kind === 'generic' && d.number) taken.add(d.number);
  let seq = 1;
  const nextFree = () => { while (taken.has(seq)) seq++; taken.add(seq); return seq; };

  const items = described.map(({ g, d }) => {
    const m = metaFor(g.file);
    let title = clip(m.title, 120);
    let titleSource = 'metadata';
    if (!title) {
      if (d.kind === 'named') { title = d.title; titleSource = 'filename'; }
      else {
        title = `Certificate ${String(d.number ?? nextFree()).padStart(2, '0')}`;
        titleSource = 'fallback';
      }
    }
    if (!title) { title = `Certificate ${String(nextFree()).padStart(2, '0')}`; titleSource = 'fallback'; }
    let unique = title, n = 2;
    while (used.has(unique.toLowerCase())) unique = `${title} (${n++})`;
    used.add(unique.toLowerCase());

    const item = {
      id: 'c' + sha1(g.file).slice(0, 8),
      file: g.file,
      src: `${base}/${encodePath(g.file)}`,
      v: g.v,
      title: unique,
      titleSource,
      width: g.info.width,
      height: g.info.height,
      format: g.info.format,
      bytes: g.bytes
    };
    const issuer = clip(m.issuer, 120), date = clip(m.date, 40, true);
    if (issuer) item.issuer = issuer;
    if (date) item.date = date;
    return item;
  });

  const manifest = { version: 1, count: items.length, items };
  if (skipped.length) manifest.skipped = skipped;
  return manifest;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { check: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--dir' || a === '--out' || a === '--base') out[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = parseArgs(argv);
  const dir = path.resolve(args.dir || path.join(root, 'images', 'certificates'));
  const out = path.resolve(args.out || path.join(dir, MANIFEST_NAME));
  const log = (m) => { if (!args.quiet) console.log(m); };

  const manifest = await buildManifest({ dir, base: args.base || 'images/certificates', warn: (m) => console.warn('warning: ' + m) });
  const next = JSON.stringify(manifest, null, 2) + '\n';
  let current = null;
  try { current = await readFile(out, 'utf8'); } catch { /* not generated yet */ }

  if (args.check) {
    if (current === next) { log(`manifest is up to date (${manifest.count} certificates)`); return 0; }
    console.error('manifest is out of date. Run: node scripts/generate-certificates.mjs');
    return 1;
  }
  if (current === next) { log(`manifest unchanged (${manifest.count} certificates)`); return 0; }
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, next);
  log(`wrote ${path.relative(process.cwd(), out) || out} (${manifest.count} certificates${manifest.skipped ? `, ${manifest.skipped.length} skipped` : ''})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
