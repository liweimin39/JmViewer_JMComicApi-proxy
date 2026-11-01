/**
 * Cloudflare Workers 入口。
 * 部署：wrangler secret put API_KEY && wrangler deploy
 */

import { handleRequest } from './core/handler.js'

export default {
  async fetch(request, env) {
    return handleRequest(request, env)
  },
}
