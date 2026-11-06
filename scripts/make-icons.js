#!/usr/bin/env node
// Writes public/icon-192.png and public/icon-512.png: a lightning bolt on the accent colour.
// Zero dependencies; the PNG is assembled by hand with zlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x00, 0x5c, 0x8a];
const FG = [0xf5, 0xa6, 0x23];
// Same bolt as the favicon, in a 32x32 box: M18 2 6 18h8l-2 12 14-18h-8z
const BOLT = [[18, 2], [6, 18], [14, 18], [12, 30], [26, 12], [18, 12]];

function inside(x, y, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  // Bolt occupies the middle 60% so maskable icons keep it inside the safe zone.
  const pad = size * 0.2, scale = (size - 2 * pad) / 32;
  const ss = 3; // supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const px = (x + (sx + 0.5) / ss - pad) / scale, py = (y + (sy + 0.5) / ss - pad) / scale;
        if (inside(px, py, BOLT)) cover++;
      }
      const a = cover / (ss * ss);
      const off = y * (size * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[off + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [192, 512]) {
  const file = path.join(__dirname, '..', 'public', `icon-${size}.png`);
  fs.writeFileSync(file, png(size));
  console.log('wrote', path.relative(process.cwd(), file));
}
