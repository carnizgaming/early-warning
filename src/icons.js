// Tiny PNG painter for the app and tray icons (no image files or extra libraries needed).
'use strict';
const zlib = require('zlib');

function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h, px) { // px(x,y) -> [r,g,b,a]
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const p = px(x + 0.5, y + 0.5), o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2]; raw[o + 3] = p[3]; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
// coverage of a shape with soft 1px edge
const edge = d => Math.max(0, Math.min(1, 0.5 - d));

// Status dot for the tray: coloured disc with a dark ring
const LEVEL_COLOURS = { info: '#3ccf7a', watch: '#e3c341', warning: '#f08a24', critical: '#ff3b3b', stale: '#8b97a5' };
function trayIcon(level, size = 32) {
  const c = hex(LEVEL_COLOURS[level] || LEVEL_COLOURS.stale), ring = [18, 23, 29], r = size / 2;
  return png(size, size, (x, y) => {
    const d = Math.hypot(x - r, y - r);
    const outer = edge(d - (r - 1)), inner = edge(d - (r - 1 - size * 0.12));
    if (outer <= 0) return [0, 0, 0, 0];
    const col = mix(ring, c, inner);
    return [...col, Math.round(255 * outer)];
  });
}
// App icon: dark rounded square with an orange warning triangle and a pulse line
function appIcon(size = 512) {
  const bg = hex('#12171d'), or = hex('#f08a24'), dark = hex('#0b0e12'), S = size, rad = S * 0.2;
  const A = [S * 0.5, S * 0.17], B = [S * 0.84, S * 0.78], C = [S * 0.16, S * 0.78];
  const sd = (p, a, b) => { const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey); return ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / l; };
  return png(S, S, (x, y) => {
    const qx = Math.max(Math.abs(x - S / 2) - (S / 2 - rad), 0), qy = Math.max(Math.abs(y - S / 2) - (S / 2 - rad), 0);
    const box = edge(Math.hypot(qx, qy) - rad); if (box <= 0) return [0, 0, 0, 0];
    let col = bg;
    const tri = Math.min(edge(sd([x, y], A, B)), edge(sd([x, y], B, C)), edge(sd([x, y], C, A)));
    const inset = S * 0.035;
    const triIn = Math.min(edge(sd([x, y], A, B) + inset), edge(sd([x, y], B, C) + inset), edge(sd([x, y], C, A) + inset));
    col = mix(col, or, tri);
    // exclamation mark
    const bar = (Math.abs(x - S / 2) < S * 0.035 && y > S * 0.36 && y < S * 0.6) ? 1 : 0;
    const dot = edge(Math.hypot(x - S / 2, y - S * 0.68) - S * 0.04);
    col = mix(col, dark, Math.max(bar, dot) * triIn);
    return [...col, Math.round(255 * box)];
  });
}
module.exports = { trayIcon, appIcon, LEVEL_COLOURS };
