// Renders media/icon.png (128×128): a rounded indigo tile with a white "/" and a small spark.
// No dependencies — writes the PNG by hand so the icon can be regenerated anywhere.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const SS = 4; // supersampling per axis for smooth edges

function inRoundedRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), SIZE - r);
  const cy = Math.min(Math.max(y, r), SIZE - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inSpark(x, y, cx, cy, r) {
  // Four-pointed star: |dx|^0.5 + |dy|^0.5 <= r^0.5
  return Math.sqrt(Math.abs(x - cx)) + Math.sqrt(Math.abs(y - cy)) <= Math.sqrt(r);
}

function sample(x, y) {
  if (!inRoundedRect(x, y, 26)) {
    return [0, 0, 0, 0];
  }
  if (distToSegment(x, y, 74, 30, 48, 98) <= 9) {
    return [255, 255, 255, 255];
  }
  if (inSpark(x, y, 94, 82, 18)) {
    return [255, 214, 102, 255];
  }
  const t = (x + y) / (2 * SIZE);
  return [Math.round(79 + (124 - 79) * t), Math.round(70 + (58 - 70) * t), Math.round(229 + (237 - 229) * t), 255];
}

const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4);
  for (let x = 0; x < SIZE; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [r, g, b, a] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        acc[0] += r * a;
        acc[1] += g * a;
        acc[2] += b * a;
        acc[3] += a;
      }
    }
    const alpha = acc[3] / (SS * SS);
    const o = 1 + x * 4;
    row[o] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
    row[o + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
    row[o + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
    row[o + 3] = Math.round(alpha);
  }
  rows.push(row);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out}`);
