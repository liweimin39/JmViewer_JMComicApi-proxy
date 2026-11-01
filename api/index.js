/**
 * Vercel Edge Function 入口。
 * vercel.json 已配置把所有路径重写到本函数，因此可直接访问 /album?id=...
 * 环境变量在 Vercel 控制台的 Settings → Environment Variables 里配置 API_KEY。
 */

import { handleRequest } from '../src/core/handler.js'

export const config = { runtime: 'edge' }

export default function handler(request) {
  return handleRequest(request, process.env)
}
