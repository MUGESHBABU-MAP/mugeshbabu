// Tests for scripts/generate-certificates.mjs. Run: node --test scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseImage, makeTitle, describeName, buildManifest } from './generate-certificates.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'generate-certificates.mjs');
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAAKABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwAJCQkJCQkQCQkQFhAQEBYeFhYWFh4mHh4eHh4mLiYmJiYmJi4uLi4uLi4uNzc3Nzc3QEBAQEBISEhISEhISEhI/9sAQwELDAwSERIfEREfSzMqM0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tL/90ABAAB/9oADAMBAAIRAxEAPwDrfCS3UmnEMXEYbEYyMgdADwecAE+5rtIogAA24n1JH9K4/wAFMz2V3vJbF7NjPOPmrtAAOgpR2Bn/2Q==', 'base64');   // 16 x 10
const WEBP = Buffer.from('UklGRkQAAABXRUJQVlA4IDgAAACwAQCdASoQAAoABABoJZwAAp1mp8AAAPlvJ2INAzr+iphA0Erg3XNIbSCnA4dlh2yrXyWVoswAAA==', 'base64'); // 16 x 10

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w = 20, h = 12) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}
/** Insert an EXIF APP1 segment with the given orientation right after SOI. */
function withOrientation(jpg, orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(orientation, 18);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpg.subarray(0, 2), seg, payload, jpg.subarray(2)]);
}
async function tmp() { return mkdtemp(path.join(tmpdir(), 'certs-')); }
async function put(dir, name, data) { await writeFile(path.join(dir, name), data); }

/* ------------------------------ parsers ------------------------------ */
test('parses PNG, JPEG and WebP dimensions from content', () => {
  assert.deepEqual(parseImage(png(20, 12)), { format: 'png', width: 20, height: 12 });
  assert.deepEqual(parseImage(JPG), { format: 'jpeg', width: 16, height: 10 });
  assert.deepEqual(parseImage(WEBP), { format: 'webp', width: 16, height: 10 });
});
test('swaps dimensions for rotated EXIF orientations', () => {
  assert.equal(parseImage(withOrientation(JPG, 6)).width, 10);
  assert.equal(parseImage(withOrientation(JPG, 1)).width, 16);
});
test('rejects truncated, empty and non-image data', () => {
  const p = png();
  assert.throws(() => parseImage(p.subarray(0, p.length - 20)), /truncated/);
  assert.throws(() => parseImage(JPG.subarray(0, JPG.length - 30)), /truncated/);
  assert.throws(() => parseImage(WEBP.subarray(0, WEBP.length - 10)), /truncated/);
  assert.throws(() => parseImage(Buffer.alloc(0)), /unrecognised/);
  // flipped pixel data: the chunk checksum no longer matches
  const flipped = Buffer.from(p); flipped[flipped.indexOf(Buffer.from('IDAT')) + 6] ^= 0xff;
  assert.throws(() => parseImage(flipped), /corrupt/);
  // right checksum but a broken zlib stream
  const raw = Buffer.alloc(40, 7), hdr = Buffer.alloc(13); hdr.writeUInt32BE(20, 0); hdr.writeUInt32BE(12, 4); hdr[8] = 8; hdr[9] = 2;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const brokenStream = Buffer.concat([sig, chunk('IHDR', hdr), chunk('IDAT', raw), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => parseImage(brokenStream), /corrupt/);
  // invalid colour type in the header
  const badHdr = Buffer.from(hdr); badHdr[9] = 7;
  assert.throws(() => parseImage(Buffer.concat([sig, chunk('IHDR', badHdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])), /invalid/);
  // pixel stream shorter than the dimensions require
  const shortStream = Buffer.concat([sig, chunk('IHDR', hdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(10))), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => parseImage(shortStream), /incomplete/);
  assert.throws(() => parseImage(Buffer.from('this is not an image at all, just text')), /unrecognised/);
});

/* ------------------------------ titles ------------------------------- */
test('display names', () => {
  const t = (f) => makeTitle(f);
  assert.equal(t('sap-certification.png'), 'SAP Certification');
  assert.equal(t('claude_associate.jpg'), 'Claude Associate');
  assert.equal(t('embedded-system-design.jpeg'), 'Embedded System Design');
  assert.equal(t('certificate-2025.webp'), 'Certificate 2025');
  assert.equal(t('machine-learning--bootcamp__2020.JPG'), 'Machine Learning Bootcamp 2020');
  assert.equal(t('introduction_to_the_web.png'), 'Introduction to the Web');
  assert.equal(t('aws   cloud  practitioner (1).png'), 'AWS Cloud Practitioner');
  assert.equal(t('GitHub-Actions.png'), 'GitHub Actions');
  assert.equal(t('résumé ünï (final).png'), 'Résumé Ünï (final)');
  assert.equal(t('சான்றிதழ்.png'), 'சான்றிதழ்');
});
test('generic names become neutral numbered labels', () => {
  for (const f of ['map01.jpeg', 'MAP01.JPG', 'image001.jpg', 'IMG_0007.jpg', 'photo-7.png', 'scan 07.png', 'cert7.png', 'certificate.png']) {
    assert.equal(describeName(f).kind, 'generic', f);
  }
  assert.equal(makeTitle('map01.jpeg'), 'Certificate 01');
  assert.equal(makeTitle('image001.jpg'), 'Certificate 01');
  assert.equal(makeTitle('map12.jpg'), 'Certificate 12');
  for (const f of ['IMG_20240101_123456.jpg', 'WhatsApp Image 2024-01-01 at 10.00.00 AM.jpeg', 'Screenshot 2024-05-05.png', 'PXL_20240101_101010.jpg', '12345678.png']) {
    assert.equal(describeName(f).kind, 'generic', f);
    assert.equal(describeName(f).number, null, f);
  }
});
test('never produces an empty title', async () => {
  for (const f of ['___.png', '---.jpg', '   .png', '(1).png', '\u200b\u200b.png', 'a.png']) {
    assert.ok(makeTitle(f).length > 0, JSON.stringify(f));
    assert.doesNotMatch(makeTitle(f), /undefined|null/);
  }
});

/* ------------------------------ manifest ----------------------------- */
test('filters hidden, directories, unsupported, temporary and symlinks; keeps valid images', async () => {
  const d = await tmp();
  await put(d, 'good.png', png());
  await put(d, 'Another.JPG', JPG);
  await put(d, 'third.WebP', WEBP);
  await put(d, '.hidden.png', png());
  await put(d, '.DS_Store', 'x');
  await put(d, 'notes.txt', 'x');
  await put(d, 'doc.pdf', 'x');
  await put(d, 'vector.svg', '<svg/>');
  await put(d, 'photo.png.tmp', png());
  await put(d, 'upload.jpg.crdownload', JPG);
  await put(d, '~lock.png', png());
  await put(d, 'Thumbs.db', 'x');
  await put(d, 'certificates.json', '{}');
  await mkdir(path.join(d, 'folder.png'));
  await mkdir(path.join(d, 'sub')); await put(path.join(d, 'sub'), 'nested.png', png());
  await symlink(path.join(d, 'good.png'), path.join(d, 'link.png'));
  const m = await buildManifest({ dir: d });
  assert.deepEqual(m.items.map((i) => i.file), ['Another.JPG', 'good.png', 'third.WebP']);
  assert.equal(m.count, 3);
  assert.equal(m.skipped, undefined);
  await rm(d, { recursive: true });
});
test('corrupt, empty and fake images are skipped without failing the rest', async () => {
  const d = await tmp();
  await put(d, 'ok.png', png());
  await put(d, 'cut.png', png().subarray(0, 60));
  await put(d, 'cut.jpg', JPG.subarray(0, 200));
  await put(d, 'empty.webp', Buffer.alloc(0));
  await put(d, 'fake.jpg', 'definitely not a jpeg');
  const m = await buildManifest({ dir: d });
  assert.deepEqual(m.items.map((i) => i.file), ['ok.png']);
  assert.deepEqual(m.skipped.map((s) => s.file).sort(), ['cut.jpg', 'cut.png', 'empty.webp', 'fake.jpg']);
  await rm(d, { recursive: true });
});
test('empty and missing folders give an empty, valid manifest', async () => {
  const d = await tmp();
  assert.deepEqual(await buildManifest({ dir: d }), { version: 1, count: 0, items: [] });
  assert.deepEqual(await buildManifest({ dir: path.join(d, 'nope') }), { version: 1, count: 0, items: [] });
  await rm(d, { recursive: true });
});
test('duplicate display names stay unique and ids are unique', async () => {
  const d = await tmp();
  await put(d, 'map02.jpeg', JPG); await put(d, 'map02.jpg', WEBP);
  await put(d, 'sap-certification.png', png()); await put(d, 'SAP_Certification.jpg', JPG); await put(d, 'sap certification (1).webp', WEBP);
  await put(d, 'IMG_20240101_1.jpg', JPG); await put(d, 'IMG_20240101_2.jpg', JPG);
  const m = await buildManifest({ dir: d });
  const titles = m.items.map((i) => i.title.toLowerCase());
  assert.equal(new Set(titles).size, titles.length, titles.join(' | '));
  assert.equal(new Set(m.items.map((i) => i.id)).size, m.items.length);
  assert.ok(m.items.every((i) => i.title && !/undefined|null/.test(i.title)));
  await rm(d, { recursive: true });
});
test('special characters and unicode are URL-encoded; original name is kept', async () => {
  const d = await tmp();
  const names = ['my cert (final) #1 100% [v2].png', "o'brien & sons!.jpg", 'ünïcödé 证书.webp', 'a+b=c;d,e.png'];
  for (const n of names) await put(d, n, n.endsWith('.png') ? png() : n.endsWith('.jpg') ? JPG : WEBP);
  const m = await buildManifest({ dir: d });
  assert.equal(m.items.length, names.length);
  for (const it of m.items) {
    assert.ok(names.includes(it.file));
    assert.match(it.src, /^images\/certificates\/[A-Za-z0-9%._~-]+$/, it.src);
    assert.equal(decodeURIComponent(it.src.split('/').pop()), it.file);
  }
  await rm(d, { recursive: true });
});
test('output is deterministic, sorted naturally, and carries no timestamps', async () => {
  const d = await tmp();
  for (const n of ['map10.png', 'map2.png', 'map1.png', 'Map3.png']) await put(d, n, png());
  const a = await buildManifest({ dir: d }), b = await buildManifest({ dir: d });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(a.items.map((i) => i.file), ['map1.png', 'map2.png', 'Map3.png', 'map10.png']);
  assert.doesNotMatch(JSON.stringify(a), /20\d\d-\d\d-\d\d/);
  await rm(d, { recursive: true });
});
test('optional metadata overrides titles; invalid metadata is ignored', async () => {
  const d = await tmp();
  await put(d, 'a.png', png()); await put(d, 'b.png', png());
  await put(d, 'certificates.meta.json', JSON.stringify({ 'a.png': { title: '  Real   Title ', issuer: 'Issuer', date: '2024' }, 'b.png': 'oops' }));
  const m = await buildManifest({ dir: d });
  assert.equal(m.items[0].title, 'Real Title'); assert.equal(m.items[0].titleSource, 'metadata');
  assert.equal(m.items[0].issuer, 'Issuer');
  assert.equal(m.items[1].title, 'B');
  await put(d, 'certificates.meta.json', '{ not json');
  assert.equal((await buildManifest({ dir: d })).items[0].title, 'A');
  await rm(d, { recursive: true });
});

/* -------------------- add / remove / regenerate via CLI -------------------- */
function run(args) { return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }); }
test('CLI: new image appears, deleted image disappears, --check detects staleness', async () => {
  const d = await tmp();
  const out = path.join(d, 'certificates.json');
  await put(d, 'one.png', png());
  assert.equal(run(['--dir', d, '--quiet']).status, 0);
  let m = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(m.items.map((i) => i.file), ['one.png']);
  assert.equal(run(['--dir', d, '--check', '--quiet']).status, 0);

  await put(d, 'two.jpg', JPG);            // add
  assert.equal(run(['--dir', d, '--check', '--quiet']).status, 1, 'stale after add');
  run(['--dir', d, '--quiet']);
  m = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(m.items.map((i) => i.file), ['one.png', 'two.jpg']);

  await rm(path.join(d, 'one.png'));       // remove
  run(['--dir', d, '--quiet']);
  m = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(m.items.map((i) => i.file), ['two.jpg']);

  await rm(path.join(d, 'two.jpg'));       // empty again
  run(['--dir', d, '--quiet']);
  m = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(m.count, 0);
  assert.equal(run(['--dir', d, '--check', '--quiet']).status, 0);
  await rm(d, { recursive: true });
});

test('metadata: custom title and issuer, fallback to the file name, never empty or undefined', async () => {
  const d = await tmp();
  for (const n of ['custom.png', 'issuer-only.png', 'empty-title.png', 'bad-types.png', 'number-title.png', 'plain-file.png', 'long.png']) await put(d, n, png());
  await put(d, 'certificates.meta.json', JSON.stringify({
    'custom.png': { title: 'Custom Title', issuer: 'Some Issuer', date: 2024 },
    'issuer-only.png': { issuer: 'Only Issuer' },
    'empty-title.png': { title: '   ', issuer: '', date: null },
    'bad-types.png': { title: { a: 1 }, issuer: ['x'], date: true },
    'number-title.png': { title: 7, issuer: 42 },
    'long.png': { title: 'x'.repeat(500), issuer: '<b>bold</b> & co' },
    'ghost.png': { title: 'Entry for a file that does not exist' }
  }));
  const m = await buildManifest({ dir: d });
  const by = Object.fromEntries(m.items.map((i) => [i.file, i]));
  assert.equal(by['custom.png'].title, 'Custom Title');
  assert.equal(by['custom.png'].issuer, 'Some Issuer');
  assert.equal(by['custom.png'].date, '2024');
  assert.equal(by['custom.png'].titleSource, 'metadata');
  assert.equal(by['issuer-only.png'].title, 'Issuer Only');          // generated title kept
  assert.equal(by['issuer-only.png'].issuer, 'Only Issuer');
  assert.equal(by['empty-title.png'].title, 'Empty Title');          // blank metadata ignored
  assert.equal(by['bad-types.png'].title, 'Bad Types');
  assert.equal(by['number-title.png'].title, 'Number Title');       // numbers are only valid for date
  assert.ok(!('issuer' in by['number-title.png']));
  assert.equal(by['plain-file.png'].title, 'Plain File');
  assert.equal(by['long.png'].title.length, 120);
  assert.equal(by['long.png'].issuer, '<b>bold</b> & co');           // stored as text; the page never parses it
  for (const i of m.items) {
    assert.ok(i.title.length > 0);
    for (const k of ['issuer', 'date']) if (k in i) assert.ok(i[k].length > 0, `${i.file}.${k}`);
    assert.doesNotMatch(JSON.stringify(i), /undefined|null|\[object/);
  }
  assert.equal(m.items.length, 7, 'metadata for a missing file adds nothing');
  await rm(d, { recursive: true });
});
test('metadata: keys match ignoring case and Unicode form; duplicate metadata titles stay unique', async () => {
  const d = await tmp();
  const composed = 'caf\u00e9.png', decomposed = 'cafe\u0301.png';
  await put(d, composed, png()); await put(d, 'UPPER.PNG', png()); await put(d, 'a.png', png()); await put(d, 'b.png', png());
  await put(d, 'certificates.meta.json', JSON.stringify({
    [decomposed]: { title: 'Accent Match' }, 'upper.png': { title: 'Case Match' },
    'a.png': { title: 'Same Title' }, 'b.png': { title: 'same title' }
  }));
  const m = await buildManifest({ dir: d });
  const titles = m.items.map((i) => i.title);
  assert.ok(titles.includes('Accent Match') && titles.includes('Case Match'), titles.join('|'));
  assert.deepEqual(titles.filter((t) => /same title/i.test(t)).sort(), ['Same Title', 'same title (2)']);
  assert.equal(new Set(titles.map((t) => t.toLowerCase())).size, titles.length);
  await rm(d, { recursive: true });
});
test('large images produce a warning but are still included', async () => {
  const d = await tmp(); const warnings = [];
  const big = Buffer.concat([png(), Buffer.alloc(1.6 * 1024 * 1024)]); // valid PNG followed by padding
  await put(d, 'big.png', big);
  const m = await buildManifest({ dir: d, warn: (w) => warnings.push(w) });
  assert.equal(m.count, 1);
  assert.ok(warnings.some((w) => /big\.png is 1\.\d MB/.test(w)), warnings.join('|'));
  await rm(d, { recursive: true });
});
