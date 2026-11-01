/**
 * HTTP 响应与 CORS 工具（只依赖标准 Request / Response）。
 */

function parseOriginList(env) {
  return String(env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function corsHeaders(request, env) {
  const allowed = parseOriginList(env)
  const origin = request.headers.get('Origin')
  let allowOrigin = '*'
  if (allowed.length && !allowed.includes('*')) {
    allowOrigin = origin && allowed.includes(origin) ? origin : ''
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Api-Key, X-Key, Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'X-Proxy-Server, X-Proxy-Ms, X-Proxy-Timestamp',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export function jsonResponse(body, { status = 200, request, env, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
      ...headers,
    },
  })
}

export function errorResponse(message, { status = 500, request, env } = {}) {
  return jsonResponse({ ok: false, error: message }, { status, request, env })
}

export function preflightResponse(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) })
}
