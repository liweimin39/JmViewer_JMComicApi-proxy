/**
 * EdgeOne Pages / Makers Functions 入口（同时兼容 Cloudflare Pages Functions 的写法）。
 * 目录约定：functions/[[path]].js 捕获所有路径。
 *
 * EdgeOne 两种导出形式都认：`export function onRequest` 与 `export default function onRequest`，
 * 这里两者都提供，避免平台切换 handler 解析方式后函数不生效。
 */

import { handleRequest } from '../src/core/handler.js'

export async function onRequest(context) {
  return handleRequest(context.request, context.env || {})
}

export default onRequest
