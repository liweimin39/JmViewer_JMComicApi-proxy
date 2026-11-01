/**
 * 纯 JS MD5（UTF-8 输入 → 32 位小写十六进制）。
 *
 * 不依赖 Node crypto / WebCrypto，可在 Cloudflare Workers、EdgeOne Pages Functions、
 * Vercel Edge Function、浏览器和 Node 中直接运行。
 */

const SHIFT = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
])

// K[i] = floor(abs(sin(i + 1)) * 2^32)，按 32 位有符号整数保存
const K = new Int32Array(64)
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0
}

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0
}

function toHex(x) {
  let out = ''
  for (let i = 0; i < 4; i++) {
    out += ((x >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')
  }
  return out
}

/**
 * @param {string|Uint8Array} input
 * @returns {string} 32 位小写十六进制摘要
 */
export function md5(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const len = bytes.length
  const total = (((len + 8) >>> 6) + 1) * 64
  const msg = new Uint8Array(total)
  msg.set(bytes)
  msg[len] = 0x80

  // 消息长度（bit），小端写入最后 8 字节；高 32 位对本文档场景恒为 0
  const bitLen = len * 8
  msg[total - 8] = bitLen & 0xff
  msg[total - 7] = (bitLen >>> 8) & 0xff
  msg[total - 6] = (bitLen >>> 16) & 0xff
  msg[total - 5] = (bitLen >>> 24) & 0xff

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  for (let off = 0; off < total; off += 64) {
    const M = new Int32Array(16)
    for (let i = 0; i < 16; i++) {
      const p = off + i * 4
      M[i] = msg[p] | (msg[p + 1] << 8) | (msg[p + 2] << 16) | (msg[p + 3] << 24)
    }

    let A = a0
    let B = b0
    let C = c0
    let D = d0

    for (let i = 0; i < 64; i++) {
      let F
      let g
      if (i < 16) {
        F = (B & C) | (~B & D)
        g = i
      } else if (i < 32) {
        F = (D & B) | (~D & C)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        F = B ^ C ^ D
        g = (3 * i + 5) % 16
      } else {
        F = C ^ (B | ~D)
        g = (7 * i) % 16
      }

      const tmp = (A + F + K[i] + M[g]) | 0
      A = D
      D = C
      C = B
      B = (B + rotl(tmp, SHIFT[i])) | 0
    }

    a0 = (a0 + A) | 0
    b0 = (b0 + B) | 0
    c0 = (c0 + C) | 0
    d0 = (d0 + D) | 0
  }

  return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0)
}
