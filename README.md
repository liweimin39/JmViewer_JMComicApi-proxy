# JmViewer JMComicApi 反向代理

给 [JmViewer](https://github.com/liweimin39/JmViewer) 使用的禁漫 API 反向代理：
**取时间戳令牌和解密全部放到服务端**，客户端只带一把配置好的 KEY，不再处理时间戳、
AES 密钥和 CDN 缓存问题。

支持 **Cloudflare Workers / EdgeOne Pages Functions / Vercel**，零依赖、无 Node 专有 API
（MD5 与 AES-256-ECB 用纯 JS 实现），同一套代码三处复用。

> ⚠️ 本项目仅做协议转发与解密研究，请遵守所在地法律法规，不要用于商业传播。
> 你部署的代理包含自己的 KEY，请勿公开分享实例地址。

---

## 1. 为什么需要它

原客户端逻辑（`src/api/JmcomicApi.js` + `Crypto.js`）：

| 环节 | 原实现 | 问题 |
| --- | --- | --- |
| 访问令牌 | `MD5(本地当前秒 + "185Hcomic3PAPP7R")`，`tokenParam = "<秒>,3.2.0"` | 设备时钟不准 / 跨时区 → 401、403 |
| 上游响应 | AES-256-ECB，密钥 `MD5(时间戳 + 模板)` | 客户端必须持有算法与时间戳，一旦 CDN 返回旧响应就解不出 |
| CDN | 接口走 CDN，同一 URL 可能被缓存 | 缓存的响应绑定了旧时间戳，令牌校验直接失配 |

改成服务端代理后：

1. 令牌由服务器时间生成，与客户端设备无关；
2. 每个请求追加 `_t=<毫秒>` 击穿参数，并带 `cache-control: no-cache`，避免命中 CDN 旧缓存；
3. 失败自动「换上游服务器 → 换新时间戳重试」，客户端拿到的永远是明文 JSON；
4. 客户端只需要一个 `API_KEY`，AES 密钥不再下发到客户端。

## 2. 请求链路

```
JmViewer 客户端
   │  GET https://<你的代理域名>/album?id=123
   │  Header: X-Api-Key: <API_KEY>
   ▼
反向代理（Cloudflare Workers / EdgeOne / Vercel）
   │  1. 校验 API_KEY
   │  2. 取 newsvr 服务器列表（解密，缓存 60s）
   │  3. 用服务器时间生成 token / tokenParam，请求上游
   │  4. 用同一时间戳派生 AES 密钥解密 data
   ▼
{ "ok": true, "code": 200, "data": {...明文...}, "meta": {...} }
```

## 3. 目录结构

```
JmViewer_JMComicApi-proxy/
├── src/
│   ├── core/
│   │   ├── handler.js      # 路由、鉴权、CORS（标准 Request/Response，平台无关）
│   │   └── upstream.js     # 令牌生成、上游请求、重试、图片转发
│   ├── lib/
│   │   ├── md5.js          # 纯 JS MD5
│   │   ├── aes.js          # 纯 JS AES-256-ECB 解密（WebCrypto 不支持 ECB）
│   │   ├── jm-crypto.js    # 上游协议：令牌 / data 解密 / 服务器列表解密
│   │   └── http.js         # JSON 响应与 CORS
│   └── worker.js           # Cloudflare Workers 入口
├── functions/[[path]].js   # EdgeOne Pages Functions（兼容 Cloudflare Pages Functions）
├── api/index.js            # Vercel Edge Function 入口
├── test/selftest.js        # 57 项离线自测
├── wrangler.toml
├── vercel.json
└── .dev.vars.example
```

## 4. 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `API_KEY` | ✅ | — | 客户端必须携带的密钥；未配置时所有接口返回 500 |
| `ALLOWED_ORIGINS` | | `*` | 允许的跨域来源，逗号分隔；设为具体域名可防止被随意调用 |
| `UPSTREAM` | | 自动拉取 | 固定上游 API 域名列表，逗号分隔；配置后跳过 newsvr 拉取 |
| `SERVER_LIST_URL` | | 官方 newsvr 地址 | 服务器列表地址，可换成自己的镜像 |
| `IMG_SERVERS` | | 内置 6 个 | 图片域名列表，供 `/media/*` 转发使用；**第 0 个必须是返回 `Access-Control-Allow-Origin` 的域名**（回退直链会用它） |
| `REQUEST_TIMEOUT_MS` | | `15000` | 上游请求超时（毫秒） |
| `MEDIA_FALLBACK` | | `redirect` | 取图失败时的处理：`redirect` = 302 到真实图源（客户端自己取，适合 Workers 出口被图片 CDN 拦截的情况）；`error` = 返回 502 |

## 5. 接口

鉴权三选一：`X-Api-Key: <KEY>`、`Authorization: Bearer <KEY>`、`?key=<KEY>`。

| 方法 | 路径 | 透传参数 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | — | 健康检查（无需密钥） |
| GET | `/` | — | 接口清单（无需密钥） |
| GET | `/servers` | — | 解密后的上游服务器列表 |
| GET | `/search` | `search_query`、`o`、`page` | 搜索 |
| GET | `/latest` | `page` | 最新 |
| GET | `/promote` | `page` | 推广位 |
| GET | `/album` | `id` | 漫画详情 |
| GET | `/chapter` | `id` | 章节详情 |
| GET | `/forum` | `page`、`mode`、`aid` | 评论 |
| GET | `/categories` | — | 分类 |
| GET | `/categories/filter` | `page`、`c`、`o` | 分类筛选 |
| GET | `/media/albums/<file>` 等 | `s`（图片域名索引） | 图片转发，带 `Access-Control-Allow-Origin: *` 与长缓存；取不到时按 `MEDIA_FALLBACK` 返回 302 直链 |

统一响应结构：

```json
{
  "ok": true,
  "code": 200,
  "data": { "...": "解密后的明文" },
  "meta": { "server": "cdn-xxx", "timestamp": 1793452800, "ms": 320, "route": "/album" }
}
```

失败时：`{ "ok": false, "error": "..." }`，状态码 400 / 401 / 404 / 405 / 500 / 502。

请求示例：

```bash
curl "https://your-proxy.example.com/album?id=422085" -H "X-Api-Key: your-key"
curl "https://your-proxy.example.com/latest?page=1&key=your-key"
curl "https://your-proxy.example.com/media/albums/422085_3x4.jpg" -H "X-Api-Key: your-key"
```

## 6. 部署

### 6.1 Cloudflare Workers

```bash
npm install                         # 仅需 wrangler
npx wrangler login
npx wrangler secret put API_KEY     # 输入你的密钥，例如一串 32 位随机串
npx wrangler deploy
```

- `wrangler.toml` 已指向 `src/worker.js`，非敏感变量（`ALLOWED_ORIGINS`、`REQUEST_TIMEOUT_MS`）写在 `[vars]`
- 部署后地址形如 `https://jmviewer-jmcomic-api-proxy.<你的子域>.workers.dev`
- 建议绑定自定义域名：Workers 默认域名在国内访问不稳定
- 本地调试：复制 `.dev.vars.example` 为 `.dev.vars` 并填好 `API_KEY`，执行 `npx wrangler dev`

### 6.2 EdgeOne Pages / Makers Functions

1. 将本目录推送到 GitHub 仓库；
2. EdgeOne 控制台「Pages / Makers → 新建项目 → 导入 Git 仓库」；
3. 构建配置：框架选「其他」，构建命令留空，输出目录留空（纯函数项目）；
4. 「环境变量」中添加 `API_KEY`（可选 `ALLOWED_ORIGINS`）；
5. 部署完成后，所有路径由 `functions/[[path]].js` 接管。

`functions/` 目录写法与 Cloudflare Pages Functions 一致，`onRequest(context)` 中
`context.request` 是标准 Request，`context.env` 是环境变量对象。入口同时提供了
`export function onRequest` 与 `export default onRequest`，两种平台解析方式都能命中。

EdgeOne 新版文档（[Edge Functions](https://pages.edgeone.ai/zh/document/edge-functions)）
把函数目录写作 `edge-functions/`，并要求 `export default function onRequest(context)`。
如果你的项目只认这个目录，可新建 `edge-functions/api/[[default]].js`：

```js
import { handleRequest } from '../../src/core/handler.js'

export default function onRequest(context) {
  return handleRequest(context.request, context.env || {})
}
```

此时所有接口都在 `/api` 下（`[[default]]` 只匹配本目录层级），客户端把代理地址填成
`https://your-app.edgeone.run/api` 即可——代理会自动去掉 `/api` 前缀。

> Edge Functions 限制：代码包 5 MB、请求 body 1 MB、单次执行 CPU 200 ms（不含 I/O 等待）。
> 本代理代码量很小，CPU 主要花在纯 JS 的 AES 解密上；如果上游很慢导致超时，先调小
> `REQUEST_TIMEOUT_MS`，别把它调大。

### 6.3 Vercel

1. 推送到 GitHub，在 Vercel「Add New Project」导入；
2. 框架预设选「Other」，无需构建命令；
3. Settings → Environment Variables 添加 `API_KEY`；
4. `vercel.json` 已把所有路径重写至 `api/index.js`（Edge Runtime），因此访问根路径即可：

```bash
curl "https://your-app.vercel.app/album?id=123" -H "X-Api-Key: your-key"
```

若不想用重写，也可直接访问 `https://your-app.vercel.app/api/album?id=123`（代码会自动去掉 `/api` 前缀）。

> 出口 IP 提示：Vercel / Cloudflare 的出口 IP 不固定且经常变化，被上游风控（403）时
> 优先改 `UPSTREAM` 换一组域名，或改用固定出口的 VPS / 云函数做前置。

### 6.4 其他环境（Node 自托管）

`src/core/handler.js` 只依赖标准 `Request/Response`，Node 18+ 可直接包装：

```js
import http from 'node:http'
import { handleRequest } from './src/core/handler.js'

http.createServer(async (req, res) => {
  const url = `http://${req.headers.host}${req.url}`
  const request = new Request(url, { method: req.method, headers: req.headers })
  const response = await handleRequest(request, process.env)
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}).listen(8080)
```

## 7. 本地自测

```bash
node test/selftest.js
```

覆盖 57 项：MD5 向量与 Node `crypto` 对拍、AES-256-ECB 往返（1 B ~ 4 KB）、
明文/密文/提示文案三种解密分支、错误时间戳必须抛错、base64 边界（非法字符 / URL-safe / 省略填充）、
鉴权三种方式、`/api` 前缀兼容、`_t` 击穿参数、图片转发与 CORS 预检、图片 403 回退直链、
上游返回非法内容或抛运行时异常时只返回 JSON 502。
全程使用假上游，不访问真实站点；假 fetch 还会模拟 Cloudflare Workers 不支持 `RequestInit.cache`。

## 8. JmViewer 客户端接入

把请求与解密替换成一次代理调用即可（以专辑详情为例）：

```js
// 原实现：本地取时间戳 → 带 token 请求 → Crypto.decryptData
const res = await fetch(`${PROXY_BASE}/album?id=${comicId}`, {
  headers: { 'X-Api-Key': API_KEY },
})
const body = await res.json()
if (!body.ok) throw new Error(body.error)
return body.data   // 已经是明文对象
```

建议在设置页新增两项（可参考 `ReaderSettings.vue` 的写法）：

- `api_proxy_url`：例如 `https://jmapi.yourdomain.com`
- `api_proxy_key`：与服务端 `API_KEY` 一致

图片地址也可统一走代理（顺带解决封面下载的 CORS 问题）：

```js
const coverUrl = `${PROXY_BASE}/media/albums/${id}_3x4.jpg?key=${API_KEY}`
```

## 9. 安全建议

1. `API_KEY` 使用 32 位以上随机串，定期轮换；泄露后立即 `wrangler secret put API_KEY` 覆盖；
2. `ALLOWED_ORIGINS` 在生产环境收窄到具体域名，避免被其他站点白嫖；
3. 需要更高防护时，在代理前加一层限流（Cloudflare Rate Limiting、Vercel WAF 或网关），
   或在 `handler.js` 里接入 KV/D1 做计数；
4. 不要把 `API_KEY` 写进前端代码仓库；App 内建议放在构建期注入的环境变量里；
5. 图片转发会消耗出口带宽，公开大范围使用前先评估成本。

## 10. 常见问题

- **返回 500「服务端未配置 API_KEY」**：环境变量没生效，Cloudflare 用 `wrangler secret put`，
  Pages/Vercel 在控制台添加后需要重新部署。
- **返回 502「获取服务器列表失败」**：`newsvr` 地址不可达或被你所在网络拦截，改用
  `UPSTREAM` 固定一组域名，或把 `SERVER_LIST_URL` 指向自建镜像。
- **个别接口 502「解密失败」**：上游返回了非预期的内容（例如提示文案已改为加密形式的新模板），
  可在 `src/lib/jm-crypto.js` 的 `CONTENT_TEMPLATES` 里补充模板后重新部署。
- **图片返回 403 / 502「图片获取失败」**：图片 CDN 会拦截数据中心出口 IP（Cloudflare Workers 常见）。
  代理已带浏览器 UA / Referer 并会在多台图源间重试；仍失败时默认 302 跳到真实图源，由客户端自己下载。
  想保持严格代理可以设 `MEDIA_FALLBACK=error`，但那样在 Workers 上大概率取不到图。
- **EdgeOne Pages Functions 报 `InvalidCharacterError`**：早期版本用 `atob` 解码上游密文，
  EdgeOne 运行时遇到非 base64 字符会抛这个异常。现在改为内置纯 JS base64 解码，
  非法内容只会返回 502 JSON（如「服务器列表解密失败：响应内容不是合法的 base64」）。
  请更新代码后重新部署；另外整条链路已兜底，任何异常都转成 JSON 502，不会再出现平台 500 错误页。
- **图片 302 后加载失败**：只有 `IMG_SERVERS` 第 0 个域名返回 `Access-Control-Allow-Origin`，
  回退直链固定用它；如果你自定义了 `IMG_SERVERS`，请把支持 CORS 的域名放在第 0 位。
- **Android 9 / 旧 WebView 无法访问**：代理默认只返回标准 JSON 与 CORS 头，不依赖新特性；
  若客户端设置了 `X-Api-Key`，注意在旧内核上 `fetch` 头名区分大小写无影响。
