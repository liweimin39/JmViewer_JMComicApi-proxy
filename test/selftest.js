/**
 * 本地自测：node test/selftest.js
 * 覆盖 MD5 / AES-256-ECB / 解密策略 / 路由 / 鉴权 / CORS，全程不访问真实上游。
 */

import nodeCrypto from 'node:crypto'
import { md5 } from '../src/lib/md5.js'
import { aesDecryptEcb } from '../src/lib/aes.js'
import { decryptContent, decryptServerList } from '../src/lib/jm-crypto.js'
import { handleRequest } from '../src/core/handler.js'

const SERVER_SEED = 'diosfjckwpqpdfjkvnqQjsik'
const SERVER_LIST = ['api-a.test', 'api-b.test', 'api-c.test', 'api-d.test', 'api-e.test']

let passed = 0
let failed = 0

function check(name, cond, extra) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

function encrypt(text, key) {
  const cipher = nodeCrypto.createCipheriv('aes-256-ecb', Buffer.from(key, 'utf8'), null)
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64')
}

function jsonRes(body) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

function makeFetch(calls, options = {}) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} })
    if (String(url).includes('newsvr-2025.txt')) {
      // 真实接口返回的是纯密文文本，不是 JSON
      return new Response(encrypt(JSON.stringify({ Server: SERVER_LIST }), md5(SERVER_SEED)))
    }
    if (String(url).includes('/media/')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    if (options.throwAlways) throw new Error('network down')

    const ts = Number(String(init.headers?.tokenParam || '').split(',')[0])
    const key = md5(`${ts}185Hcomic3PAPP7R`)
    const payload = options.plaintext
      ? { code: 200, data: options.plaintext }
      : { code: 200, data: encrypt(JSON.stringify({ path: new URL(String(url)).pathname }), key) }
    return jsonRes(payload)
  }
}

function req(path, { headers = {}, method = 'GET' } = {}) {
  return new Request(`https://proxy.test${path}`, { method, headers })
}

const env = { API_KEY: 'test-key' }

console.log('\n[1] MD5')
for (const text of ['', 'abc', '185Hcomic3PAPP7R', 'x'.repeat(1000)]) {
  const ref = nodeCrypto.createHash('md5').update(text).digest('hex')
  check(`向量 ${text.slice(0, 10) || '(空)'}`, md5(text) === ref)
}

console.log('\n[2] AES-256-ECB')
const aesKey = md5('185Hcomic3PAPP7R')
for (const plain of ['x', 'hello 世界', 'a'.repeat(4096)]) {
  const enc = Buffer.from(encrypt(plain, aesKey), 'base64')
  const dec = Buffer.from(aesDecryptEcb(new Uint8Array(enc), aesKey)).toString('utf8')
  check(`往返 ${plain.length} 字节`, dec === plain)
}

console.log('\n[3] 解密策略')
check('对象直接返回', decryptContent(1, { a: 1 }).a === 1)
check('明文 JSON 解析', decryptContent(1, '{"a":2}').a === 2)
check('提示文案原样返回', decryptContent(1, '通知已讀') === '通知已讀')

const ts = Math.floor(Date.now() / 1000)
const cipherText = encrypt('{"id":123}', md5(`${ts}185Hcomic3PAPP7R`))
check('时间戳密钥解密', decryptContent(ts, cipherText).id === 123)
let threw = false
try {
  decryptContent(ts + 3600, cipherText)
} catch {
  threw = true
}
check('错误时间戳抛出异常', threw)

const serversCipher = encrypt(JSON.stringify({ Server: SERVER_LIST }), md5(SERVER_SEED))
check('服务器列表解密', decryptServerList(serversCipher).Server.length === SERVER_LIST.length)

console.log('\n[4] 路由与鉴权')
const calls = []
const fetchImpl = makeFetch(calls)

const healthRes = await handleRequest(req('/health'), env, { fetch: fetchImpl })
check('/health 无需密钥', healthRes.status === 200)

const noKey = await handleRequest(req('/album?id=1'), env, { fetch: fetchImpl })
check('无密钥 401', noKey.status === 401, await noKey.text())

const wrongKey = await handleRequest(req('/album?id=1', { headers: { 'X-Api-Key': 'bad' } }), env, { fetch: fetchImpl })
check('错误密钥 401', wrongKey.status === 401)

const missingEnvKey = await handleRequest(req('/album?id=1', { headers: { 'X-Api-Key': 'x' } }), {}, { fetch: fetchImpl })
check('服务端未配置 API_KEY → 500', missingEnvKey.status === 500)

const okRes = await handleRequest(req('/album?id=1', { headers: { 'X-Api-Key': 'test-key' } }), env, { fetch: fetchImpl })
const okBody = await okRes.json()
check('Header 鉴权 200', okRes.ok && okBody.ok === true)
check('返回解密后的 data', okBody.data?.path === '/album', JSON.stringify(okBody))
check('响应不缓存', okRes.headers.get('cache-control') === 'no-store')
check('附带上游服务器信息', okRes.headers.get('x-proxy-server') === 'api-e.test')

const queryKey = await handleRequest(req('/latest?page=1&key=test-key'), env, { fetch: fetchImpl })
check('?key= 鉴权', queryKey.status === 200)

const bearer = await handleRequest(
  req('/chapter?id=9', { headers: { Authorization: 'Bearer test-key' } }),
  env,
  { fetch: fetchImpl },
)
check('Bearer 鉴权', bearer.status === 200)

const vercelPath = await handleRequest(req('/api/album?id=1', { headers: { 'X-Api-Key': 'test-key' } }), env, {
  fetch: fetchImpl,
})
check('兼容 /api 前缀', vercelPath.status === 200)

const serversRes = await handleRequest(req('/servers', { headers: { 'X-Api-Key': 'test-key' } }), env, { fetch: fetchImpl })
const serversBody = await serversRes.json()
check('/servers 返回列表', serversBody.data?.Server?.length === SERVER_LIST.length)

const plaintextRes = await handleRequest(
  req('/notify?a=1', { headers: { 'X-Api-Key': 'test-key' } }),
  env,
  { fetch: makeFetch([], { plaintext: '通知已讀' }) },
)
check('未知路由 404', plaintextRes.status === 404)

console.log('\n[5] 图片与预检')
const mediaRes = await handleRequest(req('/media/albums/1_3x4.jpg?s=2', { headers: { 'X-Api-Key': 'test-key' } }), env, {
  fetch: fetchImpl,
})
check('图片 200', mediaRes.status === 200)
check('图片类型透传', mediaRes.headers.get('content-type') === 'image/jpeg')
check('图片长缓存', /max-age=604800/.test(mediaRes.headers.get('cache-control') || ''))
check('图片允许跨域', mediaRes.headers.get('access-control-allow-origin') === '*')

const preflight = await handleRequest(req('/album', { method: 'OPTIONS' }), env, { fetch: fetchImpl })
check('OPTIONS 204', preflight.status === 204)
check('预检允许 X-Api-Key', /x-api-key/i.test(preflight.headers.get('access-control-allow-headers') || ''))

console.log('\n[6] 上游与请求细节')
check('令牌请求头已设置', calls.some((c) => c.headers.token && c.headers.tokenParam))
check('带 _t 击穿参数', calls.some((c) => /_t=/.test(c.url)))
check('请求上游域名', calls.some((c) => c.url.includes('api-e.test')))

const downRes = await handleRequest(
  req('/album?id=1', { headers: { 'X-Api-Key': 'test-key' } }),
  env,
  { fetch: makeFetch([], { throwAlways: true }) },
)
const downBody = await downRes.json()
check('上游失败 502', downRes.status === 502 && downBody.ok === false, downBody.error)

console.log(`\n结果：${passed} 通过，${failed} 失败\n`)
process.exit(failed ? 1 : 0)
