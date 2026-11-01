/**
 * EdgeOne Pages Functions 入口（同时兼容 Cloudflare Pages Functions 的写法）。
 * 目录约定：functions/[[path]].js 捕获所有路径。
 */

import { handleRequest } from '../src/core/handler.js'

export async function onRequest(context) {
  return handleRequest(context.request, context.env || {})
}
