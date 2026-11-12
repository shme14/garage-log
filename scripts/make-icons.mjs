// Generates the PWA icons into public/ using only Node built-ins (zlib + a hand-rolled PNG
// encoder). Design: a white open-end wrench on the app accent blue. Run with `npm run icons`.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BG = [0x1f, 0x6f, 0xeb] // --accent in src/ui/styles.css
const FG = [0xff, 0xff, 0xff]
const SS = 4 // supersampling per axis

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0 // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Signed-distance helpers, in unit-square coordinates.
const circle = (u, v, cu, cv, r) => Math.hypot(u - cu, v - cv) - r
function capsule(u, v, u0, u1, r) {
  const t = Math.min(Math.max(u, u0), u1)
  return Math.hypot(u - t, v) - r
}

/** Is (x, y) in the unit square inside the wrench glyph? `scale` shrinks it about the centre. */
function inWrench(x, y, scale) {
  // Centre, rotate the wrench's axis onto the 45 degree diagonal, undo the scale.
  const dx = (x - 0.5) / scale
  const dy = (y - 0.5) / scale
  const c = Math.SQRT1_2
  const u = dx * c - dy * c // along the wrench, toward the top-right head
  const v = dx * c + dy * c // across it
  const handle = capsule(u, v, -0.3, 0.2, 0.055)
  // Open-end head: a disc with a rectangular jaw cut out of its far side.
  const head = circle(u, v, 0.27, 0, 0.15)
  const jaw = Math.max(0.27 - u, Math.abs(v) - 0.075) // inside jaw when u > 0.27 and |v| < 0.075
  const headShape = Math.max(head, -jaw)
  // Ring end at the bottom-left, with a hole.
  const ring = Math.max(circle(u, v, -0.3, 0, 0.1), -circle(u, v, -0.3, 0, 0.04))
  return Math.min(handle, headShape, ring) < 0
}

/** shape: 'rounded' (transparent corners) or 'full' (opaque to the edges). */
function render(size, { shape, scale }) {
  const px = Buffer.alloc(size * size * 4)
  const radius = 0.22
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let bg = 0
      let fg = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxi + (sx + 0.5) / SS) / size
          const y = (py + (sy + 0.5) / SS) / size
          let inside = true
          if (shape === 'rounded') {
            const qx = Math.abs(x - 0.5) - (0.5 - radius)
            const qy = Math.abs(y - 0.5) - (0.5 - radius)
            inside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= radius
          }
          if (!inside) continue
          bg++
          if (inWrench(x, y, scale)) fg++
        }
      }
      const total = SS * SS
      const o = (py * size + pxi) * 4
      const f = bg ? fg / bg : 0
      for (let k = 0; k < 3; k++) px[o + k] = Math.round(BG[k] * (1 - f) + FG[k] * f)
      px[o + 3] = Math.round((255 * bg) / total)
    }
  }
  return encodePng(size, size, px)
}

const outDir = fileURLToPath(new URL('../public/', import.meta.url))
mkdirSync(outDir, { recursive: true })
const icons = [
  ['icon-192.png', 192, { shape: 'rounded', scale: 1.15 }],
  ['icon-512.png', 512, { shape: 'rounded', scale: 1.15 }],
  // Maskable: full-bleed, glyph inside the central 80% safe zone so any mask shape keeps it whole.
  ['icon-maskable-512.png', 512, { shape: 'full', scale: 0.85 }],
  // iOS applies its own rounded mask, so give it an opaque full-bleed square.
  ['apple-touch-icon.png', 180, { shape: 'full', scale: 1.0 }],
]
for (const [name, size, opts] of icons) {
  writeFileSync(outDir + name, render(size, opts))
  console.log(`wrote public/${name} (${size}x${size})`)
}
