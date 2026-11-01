/**
 * 上游请求：服务器列表、访问令牌、重试与图片转发。
 *
 * 关键点（用于规避「时间戳 + CDN」问题）：
 * 1. 令牌在服务器端按当前秒生成，客户端不再依赖本地时钟；
 * 2. 每个请求追加 _t 击穿参数并带 cache-control: no-cache，避免拿到 CDN 里的旧响应；
 * 3. 失败（网络错误 / 非 2xx / 解密失败）时按「换服务器 → 换新时间戳再试」的顺序重试。
 */

import { buildToken, decryptContent, decryptServerList } from '../lib/jm-crypto.js'

export const DEFAULT_SERVER_LIST_URL =
  'https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt'

export const DEFAULT_IMG_SERVERS = [
  'cdn-msp-jmimg2.072139.dpdns.org',
  'cdn-msp.jmapiproxy2.cc',
  'cdn-msp2.jmapiproxy2.cc',
  'cdn-msp3.jmapiproxy2.cc',
  'cdn-msp.jmapinodeudzn.net',
  'cdn-msp3.jmapinodeudzn.net',
]

const SERVER_CACHE_TTL = 60 * 1000
let serverCache = { servers: [], expires: 0 }

function parseList(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.filter(Boolean)
  return String(value)
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function timeoutOf(env) {
  const value = Number(env.REQUEST_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : 15000
}

export function resolveImgServers(env) {
  const custom = parseList(env.IMG_SERVERS)
  return custom.length ? custom : DEFAULT_IMG_SERVERS
}

export async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 取上游 API 服务器列表：优先读环境变量 UPSTREAM（逗号分隔），
 * 否则拉取 newsvr 列表并解密，结果在实例内缓存 60 秒。
 */
export async function getServerList(env, ctx) {
  const fixed = parseList(env.UPSTREAM)
  if (fixed.length) return fixed

  if (serverCache.servers.length && serverCache.expires > Date.now()) {
    return serverCache.servers
  }

  const url = env.SERVER_LIST_URL || DEFAULT_SERVER_LIST_URL
  // ★ 不要写 cache: 'no-store'：Cloudflare Workers 的 fetch 不支持 RequestInit.cache，
  //   会抛 "The 'cache' field on 'RequestInitializerDict' is not implemented"。
  //   绕过 CDN 缓存用请求头 cache-control: no-cache（外加 URL 上的时间戳参数）。
  const res = await fetchWithTimeout(
    ctx.fetch,
    url,
    { headers: { 'cache-control': 'no-cache' }, redirect: 'follow' },
    timeoutOf(env),
  )
  if (!res.ok) throw new Error(`获取服务器列表失败：HTTP ${res.status}`)

  const text = (await res.text()).trim()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = decryptServerList(text)
  }

  const servers = Array.isArray(parsed?.Server) ? parsed.Server.filter(Boolean) : []
  if (!servers.length) throw new Error('服务器列表解析失败')

  serverCache = { servers, expires: Date.now() + SERVER_CACHE_TTL }
  return servers
}

/**
 * 沿用原客户端的取服顺序：优先 servers[4]，再依次向前。
 */
export function orderServers(servers) {
  const preferred = [4, 3, 2, 1, 0, 5, 6, 7, 8, 9, 10]
  const seen = new Set()
  const order = []
  for (const index of preferred) {
    const server = servers[index]
    if (server && !seen.has(server)) {
      seen.add(server)
      order.push(server)
    }
  }
  for (const server of servers) {
    if (server && !seen.has(server)) {
      seen.add(server)
      order.push(server)
    }
  }
  return order
}

/**
 * 调用上游接口并返回解密后的数据。
 * @param {{upstreamPath: string, params?: Record<string,string>, env: object, ctx: {fetch: Function}}} options
 */
export async function callApi({ upstreamPath, params = {}, env, ctx }) {
  const servers = await getServerList(env, ctx)
  if (!servers.length) throw new Error('上游服务器列表为空')

  const order = orderServers(servers)
  const timeout = timeoutOf(env)
  let lastError = null

  // 第一轮用当前时间戳，第二轮换新时间戳（应对 CDN 缓存了旧令牌对应内容的情况）
  for (let attempt = 0; attempt < 2; attempt++) {
    const timestamp = Math.floor(Date.now() / 1000)
    const { token, tokenParam } = buildToken(timestamp)

    for (const server of order) {
      const query = new URLSearchParams(params)
      query.set('_t', String(Date.now()))
      const url = `https://${server}${upstreamPath}?${query.toString()}`

      try {
        const res = await fetchWithTimeout(
          ctx.fetch,
          url,
          {
            headers: {
              token,
              tokenParam,
              accept: 'application/json',
              'cache-control': 'no-cache',
            },
            redirect: 'follow',
          },
          timeout,
        )
        const text = await res.text()
        if (!res.ok) {
          lastError = new Error(`上游 HTTP ${res.status}`)
          continue
        }

        let body
        try {
          body = JSON.parse(text)
        } catch {
          lastError = new Error('上游返回非 JSON')
          continue
        }

        const data = decryptContent(timestamp, body?.data ?? body)
        return {
          code: body?.code ?? 200,
          data,
          server,
          timestamp,
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }
  }

  throw lastError || new Error('上游请求失败')
}

/**
 * 图片转发：path 形如 media/albums/123_3x4.jpg。
 */
export async function fetchMedia(path, { serverIndex = 0, env, ctx }) {
  const servers = resolveImgServers(env)
  const index = Number.isInteger(serverIndex) && serverIndex >= 0 ? serverIndex % servers.length : 0
  const server = servers[index]
  const res = await fetchWithTimeout(
    ctx.fetch,
    `https://${server}/${path}`,
    { headers: { 'cache-control': 'no-cache' }, redirect: 'follow' },
    timeoutOf(env),
  )
  return { response: res, server }
}
