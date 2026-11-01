/**
 * EdgeOne Makers Edge Functions 入口：捕获 /edge-functions 下一级起的全部路径。
 *
 * 路由规则（见 EdgeOne 文档）：
 * - /edge-functions/index.js        → `/`（由 index.js 负责）
 * - /edge-functions/[[default]].js  → `/album`、`/media/albums/x.jpg`、`/api/album`、……
 * - 动态段名可以任意取（`[[path]]`、`[[id]]` 等价），多级路径都能匹配
 * - 静态资源优先于函数路由，本项目没有静态资源，全部请求都会进这里
 *
 * 平台文档里的两种导出写法都提供，避免 handler 解析方式变化后函数不生效。
 */

import { handleRequest } from '../src/core/handler.js'

export async function onRequest(context) {
  return handleRequest(context.request, context.env || {})
}

export default onRequest
