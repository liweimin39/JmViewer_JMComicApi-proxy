/**
 * 上游接口的加解密约定（与原 JmViewer 客户端 src/api/Crypto.js 保持完全一致）：
 *
 * - 访问令牌：MD5(时间戳 + "185Hcomic3PAPP7R")
 * - tokemParam："<时间戳>,3.2.0"
 * - 响应体 data：AES-256-ECB / PKCS#7，密钥为 MD5(时间戳 + 模板)，模板有两个候选
 * - 服务器列表：AES-256-ECB / PKCS#7，密钥为 MD5("diosfjckwpqpdfjkvnqQjsik")
 */

import { md5 } from './md5.js'
import { aesDecryptEcb } from './aes.js'

const CONTENT_TEMPLATES = ['185Hcomic3PAPP7R', '18comicAPPContent']
const SERVER_LIST_SEED = 'diosfjckwpqpdfjkvnqQjsik'

export const TOKEN_TEMPLATE = CONTENT_TEMPLATES[0]

/**
 * 纯 JS base64 解码。
 * 不用 atob：各平台实现差异大（EdgeOne 等运行时遇到非 base64 字符会直接抛
 * InvalidCharacterError，错误信息还很难看），这里统一自己解析并给出可读错误。
 */
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_TABLE = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64_CHARS.length; i++) table[B64_CHARS.charCodeAt(i)] = i
  return table
})()

function base64Digit(text, index) {
  const code = text.charCodeAt(index)
  return code < 128 ? B64_TABLE[code] : -1
}

function base64ToBytes(text) {
  let source = String(text ?? '').replace(/[\s\uFEFF]+/g, '')
  if (!source) throw new Error('响应内容为空')
  // 兼容 URL-safe base64
  source = source.replace(/-/g, '+').replace(/_/g, '/')
  // 去掉末尾填充后按长度补齐，兼容省略 = 的变体
  source = source.replace(/=+$/, '')
  const remainder = source.length % 4
  if (remainder === 1) throw new Error('响应内容不是合法的 base64')
  const padding = remainder === 0 ? 0 : 4 - remainder
  const bytes = new Uint8Array(((source.length + padding) / 4) * 3 - padding)

  let offset = 0
  for (let i = 0; i < source.length; i += 4) {
    let value = 0
    let digits = 0
    const end = Math.min(i + 4, source.length)
    for (let j = i; j < end; j++) {
      const digit = base64Digit(source, j)
      if (digit < 0) throw new Error('响应内容不是合法的 base64')
      value = (value << 6) | digit
      digits++
    }
    value <<= 6 * (4 - digits)
    if (offset < bytes.length) bytes[offset++] = (value >> 16) & 0xff
    if (offset < bytes.length) bytes[offset++] = (value >> 8) & 0xff
    if (offset < bytes.length) bytes[offset++] = value & 0xff
  }

  return bytes
}

function bytesToUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/**
 * 判断是否像 AES 密文：合法 base64，且解码后长度是 16 的正整数倍。
 */
export function looksEncrypted(text) {
  if (typeof text !== 'string' || !text.trim()) return false
  if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) return false
  try {
    const raw = base64ToBytes(text)
    return raw.length > 0 && raw.length % 16 === 0
  } catch {
    return false
  }
}

/**
 * 把上游返回的 data 字段还原成明文对象 / 字符串。
 * 兼容三种情况：已经是对象、明文 JSON 字符串、AES 密文。
 * @param {number} timestamp 生成访问令牌时使用的秒级时间戳
 * @param {unknown} payload 上游响应中的 data 字段
 */
export function decryptContent(timestamp, payload) {
  if (payload && typeof payload === 'object') return payload
  if (typeof payload !== 'string') return payload

  const text = payload.trim()
  if (!text) return text

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text)
    } catch {
      // 不是合法 JSON，继续按密文处理
    }
  }

  if (!looksEncrypted(text)) return text

  for (const template of CONTENT_TEMPLATES) {
    try {
      const key = md5(`${timestamp}${template}`)
      const json = bytesToUtf8(aesDecryptEcb(base64ToBytes(text), key))
      return JSON.parse(json)
    } catch {
      continue
    }
  }
  throw new Error('解密失败：时间戳密钥不匹配')
}

/**
 * 解析服务器列表接口（newsvr-*.txt）返回的密文。
 */
export function decryptServerList(text) {
  const key = md5(SERVER_LIST_SEED)
  const source = String(text ?? '').trim()
  let json
  try {
    json = bytesToUtf8(aesDecryptEcb(base64ToBytes(source), key))
  } catch (error) {
    throw new Error(`服务器列表解密失败：${error?.message || error}`)
  }
  return JSON.parse(json)
}

/**
 * 生成某一秒的访问令牌。
 * @param {number} timestamp 秒级时间戳
 */
export function buildToken(timestamp) {
  return {
    token: md5(`${timestamp}${TOKEN_TEMPLATE}`),
    tokenParam: `${timestamp},3.2.0`,
  }
}
