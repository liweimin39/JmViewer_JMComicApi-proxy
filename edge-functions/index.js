/**
 * EdgeOne Makers Edge Functions 入口：只处理根路径 `/`。
 *
 * 目录约定：/edge-functions 下的文件即路由，`[[default]].js` 不匹配 `/`，
 * 因此根路径单独给 index.js（此时返回服务信息 JSON）。
 */

import { handleRequest } from '../src/core/handler.js'

export async function onRequest(context) {
  return handleRequest(context.request, context.env || {})
}

export default onRequest
