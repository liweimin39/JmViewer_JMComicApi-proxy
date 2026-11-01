/**
 * 平台无关的请求处理入口：输入标准 Request，输出标准 Response。
 * Cloudflare Workers、EdgeOne Pages Functions、Vercel Edge Function 都只是薄适配层。
 */

import { callApi, fetchMedia, getServerList } from './upstream.js'
import { corsHeaders, errorResponse, jsonResponse, preflightResponse } from '../lib/http.js'

export const VERSION = '1.0.0'

/**
 * 白名单接口：upstream 为上游路径，params 为允许透传的查询参数。
 */
const API_ROUTES = {
  '/search': { upstream: '/search', params: ['search_query', 'o', 'page'] },
  '/latest': { upstream: '/latest', params: ['page'] },
  '/promote': { upstream: '/promote', params: ['page'] },
  '/album': { upstream: '/album', params: ['id'] },
  '/chapter': { upstream: '/chapter', params: ['id'] },
  '/forum': { upstream: '/forum', params: ['page', 'mode', 'aid'] },
  '/categories': { upstream: '/categories', params: [] },
  '/categories/filter': { upstream: '/categories/filter', params: ['page', 'c', 'o'] },
}

function providedKey(request, url) {
  const header =
    request.headers.get('x-api-key') ||
    request.headers.get('x-key') ||
    request.headers.get('x-auth-key')
  if (header) return header.trim()

  const authorization = request.headers.get('authorization')
  if (authorization && /^bearer\s+/i.test(authorization)) {
    return authorization.replace(/^bearer\s+/i, '').trim()
  }
  return (url.searchParams.get('key') || '').trim()
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * 兼容 Vercel 的 /api 前缀与其他平台的挂载前缀。
 */
function normalizePath(pathname) {
  let path = pathname || '/'
  if (path === '/api/index' || path.startsWith('/api/index/')) {
    path = path.slice('/api/index'.length) || '/'
  }
  if (path === '/api') path = '/'
  else if (path.startsWith('/api/')) path = path.slice(4)
  return path
}

function infoResponse(request, env) {
  return jsonResponse(
    {
      ok: true,
      name: 'jmviewer-jmcomic-api-proxy',
      version: VERSION,
      auth: 'X-Api-Key / Authorization: Bearer / ?key=',
      note: '所有接口均在服务端取时间戳令牌并解密，客户端不再需要密钥与时间戳',
      endpoints: [
        ...Object.keys(API_ROUTES),
        '/servers',
        '/media/:type/:file',
        '/health',
      ],
    },
    { request, env },
  )
}

async function handleServers(request, env, ctx, startedAt) {
  const servers = await getServerList(env, ctx)
  return jsonResponse(
    {
      ok: true,
      data: { Server: servers },
      meta: { ms: Date.now() - startedAt, route: '/servers' },
    },
    { request, env, headers: { 'X-Proxy-Ms': String(Date.now() - startedAt) } },
  )
}

/** 取图失败时的处理方式：redirect（默认，302 到真实图片地址）/ error（返回 502） */
function mediaFallbackMode(env) {
  return String(env.MEDIA_FALLBACK || 'redirect').trim().toLowerCase() === 'error'
    ? 'error'
    : 'redirect'
}

async function handleMedia(request, url, env, ctx, upstreamPath) {
  const serverIndex = Number.parseInt(url.searchParams.get('s') || '0', 10)
  const media = await fetchMedia(upstreamPath, {
    serverIndex: Number.isNaN(serverIndex) ? 0 : serverIndex,
    env,
    ctx,
  })

  if (!media.response || !media.response.ok) {
    // 图片 CDN 对数据中心出口 IP 比较敏感（Cloudflare Workers 常见 403）。
    // 默认回退为 302 直链，让客户端用自己的网络直接取图；<img> 会透明跟随跳转。
    if (mediaFallbackMode(env) !== 'error') {
      return new Response(null, {
        status: 302,
        headers: {
          Location: media.url,
          'Cache-Control': 'no-store',
          'X-Proxy-Fallback': 'redirect',
          ...corsHeaders(request, env),
        },
      })
    }
    const reason = media.response ? `HTTP ${media.response.status}` : '上游不可达'
    return errorResponse(`图片获取失败：${reason}`, { status: 502, request, env })
  }

  const response = media.response
  const headers = {
    'Content-Type': response.headers.get('content-type') || 'image/jpeg',
    'Cache-Control': 'public, max-age=604800, immutable',
    'X-Proxy-Server': media.server,
    ...corsHeaders(request, env),
  }
  return new Response(response.body, { status: 200, headers })
}

async function handleApi(request, url, env, ctx, startedAt, route) {
  const params = {}
  for (const name of route.params) {
    const value = url.searchParams.get(name)
    if (value !== null && value !== '') params[name] = value
  }

  const result = await callApi({ upstreamPath: route.upstream, params, env, ctx })
  const ms = Date.now() - startedAt

  return jsonResponse(
    {
      ok: true,
      code: result.code,
      data: result.data,
      meta: {
        server: result.server,
        timestamp: result.timestamp,
        ms,
        route: route.upstream,
      },
    },
    {
      request,
      env,
      headers: {
        'X-Proxy-Server': result.server,
        'X-Proxy-Timestamp': String(result.timestamp),
        'X-Proxy-Ms': String(ms),
      },
    },
  )
}

/** 把异常转成可读文案；DOMException 之类会带上 name，便于排查平台差异 */
function describeError(error) {
  const message = error?.message || String(error)
  const name = error?.name && error.name !== 'Error' ? `${error.name}: ` : ''
  return `${name}${message}`
}

/**
 * @param {Request} request
 * @param {object} env 环境变量（各平台注入）
 * @param {{fetch?: Function}} deps 便于测试注入 fetch
 */
export async function handleRequest(request, env = {}, deps = {}) {
  const ctx = { fetch: deps.fetch || globalThis.fetch.bind(globalThis) }
  // ★ 整条链路都兜底：任何异常都返回 JSON 502，而不是让平台运行时抛 500 错误页
  //   （EdgeOne / 其他运行时对异常的处理各不相同，绝不能把异常漏出去）
  try {
    return await dispatch(request, env, ctx)
  } catch (error) {
    return errorResponse(describeError(error), { status: 502, request, env })
  }
}

async function dispatch(request, env, ctx) {
  const url = new URL(request.url)
  const path = normalizePath(url.pathname)
  const startedAt = Date.now()

  if (request.method === 'OPTIONS') return preflightResponse(request, env)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse('仅支持 GET / HEAD', { status: 405, request, env })
  }

  if (path === '/health') {
    return jsonResponse(
      { ok: true, time: new Date().toISOString(), version: VERSION },
      { request, env },
    )
  }
  if (path === '/') return infoResponse(request, env)

  const configuredKey = String(env.API_KEY || '').trim()
  if (!configuredKey) {
    return errorResponse('服务端未配置 API_KEY，请先设置环境变量', { status: 500, request, env })
  }
  if (!safeEqual(providedKey(request, url), configuredKey)) {
    return errorResponse('密钥无效', { status: 401, request, env })
  }

  if (path === '/servers') return await handleServers(request, env, ctx, startedAt)

  if (path === '/media' || path.startsWith('/media/')) {
    const rest = path.slice('/media'.length).replace(/^\/+/, '')
    if (!rest) return errorResponse('缺少图片路径', { status: 400, request, env })
    return await handleMedia(request, url, env, ctx, `media/${rest}`)
  }

  const route = API_ROUTES[path]
  if (route) return await handleApi(request, url, env, ctx, startedAt, route)

  return jsonResponse(
    {
      ok: false,
      error: '接口不存在',
      endpoints: [...Object.keys(API_ROUTES), '/servers', '/media/:type/:file'],
    },
    { status: 404, request, env },
  )
}
