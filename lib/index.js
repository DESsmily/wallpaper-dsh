/**
 * dsh-wallpaper — 主题管理插件（host 半）。
 *
 * 职责：
 *   1. 扫描壁纸来源（Wallpaper Engine 工坊 / 本地文件夹 / 单个文件 / 远端 URL）
 *   2. 提供 `/api/dsh-wallpaper/*` 路由：状态读取、配置写入、选择壁纸、媒体转发
 *   3. 把配置持久化到 `$DSH_HOME/dsh-wallpaper-theme.json`
 *
 * 媒体转发（`/media`）是唯一能读到磁盘任意文件的面，因此做了两道闸：
 * 扩展名必须是受支持的图片/视频，且 realpath 必须落在**当前配置允许的根目录**内
 * （见 `scan.js` 的 `isAllowedMedia`）。写接口另有同源校验，防浏览器里的第三方页面
 * 跨站改写配置后借 `/media` 读取本机文件。
 *
 * 本文件刻意不 import 任何 `@deepseek-ai/*` 包：插件的 peer 依赖在 profile 的
 * node_modules 下不一定可解析（本机 profile 的 `@deepseek-ai/` 就是空目录），
 * 只依赖 node 内置模块可以确保插件在任何部署下都能加载。
 *
 * @module dsh-wallpaper
 */

import { createReadStream } from 'node:fs'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

import {
  classifyPath,
  fileToWallpaper,
  isAllowedMedia,
  scanFolder,
  scanWallpaperEngine,
  urlToWallpaper,
} from './scan.js'

/** 插件名（cordis 取 `name` 作为日志与 id 来源）。 */
export const name = 'dsh-wallpaper'

/** 只依赖 web 服务器的路由注册面；缺失时插件静默不生效。 */
export const inject = ['webServer']

/** 路由前缀（`kind: 'prefix'` 单条注册，内部再分流）。 */
const ROUTE_PREFIX = '/api/dsh-wallpaper'

/** 单次扫描返回的壁纸条数上限（壁纸库动辄上千，防止设置页首次打开被拖住）。 */
const DEFAULT_MAX_ENTRIES = 500

/** 缩略图/媒体响应缓存时长（秒）；URL 里带路径，换壁纸即换 URL，缓存安全。 */
const MEDIA_CACHE_SECONDS = 3600

/** 配置默认值。所有可调参数都在这里，不在业务代码里硬编码。 */
const DEFAULT_CONFIG = {
  /** 壁纸来源：off 关闭 | folder 本地文件夹 | wallpaper-engine 工坊目录 | file 单文件 | url 远端链接 */
  mode: 'off',
  /** folder / wallpaper-engine 模式的根目录 */
  root: '',
  /** file 模式的单个媒体文件绝对路径 */
  file: '',
  /** url 模式的远端链接 */
  url: '',
  /** 当前选中的壁纸记录（含服务端已拼好的 URL），未选中为 null */
  current: null,
  /** UI 遮罩不透明度：1 = 完全不透明（看不见壁纸），0 = 完全透明 */
  opacity: 0.78,
  /** 壁纸背景模糊半径（px），0 为不模糊 */
  blur: 0,
  /** 壁纸压暗强度 0–1，提高前景文字可读性 */
  dim: 0.12,
  /** 壁纸铺满方式：cover | contain | fill */
  fit: 'cover',
}

/** 允许写入的 mode 取值。 */
const MODES = new Set(['off', 'folder', 'wallpaper-engine', 'file', 'url'])

/** 允许写入的 fit 取值。 */
const FITS = new Set(['cover', 'contain', 'fill'])

/** 扩展名 → Content-Type。仅覆盖受支持的媒体类型。 */
const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
}

/** 配置文件路径：优先 $DSH_HOME，回退 ~/.dsh。 */
function configPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-wallpaper-theme.json')
}

/** 数值夹取；非数值回退到 fallback。 */
function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 把外部输入（配置文件 / 请求体）清洗成合法配置。
 *
 * 脏字段一律回退默认值而不是抛错：配置文件被手改坏时插件应该照常可用，
 * 而不是整个 web 组合起不来。
 */
function normalizeConfig(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = MODES.has(src.mode) ? src.mode : DEFAULT_CONFIG.mode
  return {
    mode,
    root: typeof src.root === 'string' ? src.root : DEFAULT_CONFIG.root,
    file: typeof src.file === 'string' ? src.file : DEFAULT_CONFIG.file,
    url: typeof src.url === 'string' ? src.url : DEFAULT_CONFIG.url,
    current: src.current !== null && typeof src.current === 'object' ? src.current : null,
    opacity: clampNumber(src.opacity, 0, 1, DEFAULT_CONFIG.opacity),
    blur: clampNumber(src.blur, 0, 40, DEFAULT_CONFIG.blur),
    dim: clampNumber(src.dim, 0, 1, DEFAULT_CONFIG.dim),
    fit: FITS.has(src.fit) ? src.fit : DEFAULT_CONFIG.fit,
  }
}

/**
 * 服务端把壁纸记录转成客户端可直接使用的形状。
 *
 * 关键点：**不下发磁盘绝对路径**。本机路径既无必要暴露给浏览器，也会让
 * 客户端有机会自行拼 URL 绕过白名单。这里由服务端拼好 `/media?path=` 链接。
 *
 * @param {import('./scan.js').Wallpaper} item
 * @param {{ skipPath?: boolean }} [opts] skipPath=true 时省略 mediaUrl（缩略图列表用不到）
 */
function toWire(item) {
  if (item.source === 'url') {
    // 远端来源直接交给浏览器，不经本机转发
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      source: item.source,
      badge: item.badge ?? '',
      weType: item.weType ?? '',
      thumbUrl: item.thumb,
      mediaUrl: item.path,
    }
  }
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    source: item.source,
    badge: item.badge ?? '',
    weType: item.weType ?? '',
    thumbUrl: ROUTE_PREFIX + '/media?path=' + encodeURIComponent(item.thumb),
    mediaUrl: ROUTE_PREFIX + '/media?path=' + encodeURIComponent(item.path),
  }
}

/**
 * 按当前配置扫描壁纸库。
 *
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {Promise<{ items: object[], workshopRoot: string|null, error: string }>}
 */
async function scanFor(config) {
  const maxEntries = DEFAULT_MAX_ENTRIES
  try {
    if (config.mode === 'folder') {
      if (config.root.trim() === '') return { items: [], workshopRoot: null, error: '' }
      const items = await scanFolder(config.root.trim(), { maxEntries })
      return { items: items.map((i) => toWire(i)), workshopRoot: null, error: '' }
    }
    if (config.mode === 'wallpaper-engine') {
      if (config.root.trim() === '') return { items: [], workshopRoot: null, error: '' }
      const res = await scanWallpaperEngine(config.root.trim(), { maxEntries })
      if (res.root === null) {
        return { items: [], workshopRoot: null, error: '在该目录下没有找到 Wallpaper Engine 工坊内容（缺少 project.json）' }
      }
      return { items: res.items.map((i) => toWire(i)), workshopRoot: res.root, error: '' }
    }
    if (config.mode === 'file') {
      const item = await fileToWallpaper(config.file)
      if (item === null) {
        return { items: [], workshopRoot: null, error: config.file.trim() === '' ? '' : '文件不存在或不是受支持的图片/视频' }
      }
      return { items: [toWire(item)], workshopRoot: null, error: '' }
    }
    if (config.mode === 'url') {
      const item = urlToWallpaper(config.url)
      if (item === null) {
        return { items: [], workshopRoot: null, error: config.url.trim() === '' ? '' : '链接无效（需要 http/https）' }
      }
      return { items: [toWire(item)], workshopRoot: null, error: '' }
    }
    return { items: [], workshopRoot: null, error: '' }
  } catch (error) {
    return { items: [], workshopRoot: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 当前允许读盘的路径集合。
 *
 * 只开放「当前生效来源」的根目录（或单个文件），不开放所有历史配置过的目录：
 * 选中项必定落在当前来源内，无需额外放行。
 */
function allowListFor(config) {
  const roots = []
  const files = []
  if (config.mode === 'folder' || config.mode === 'wallpaper-engine') {
    if (config.root.trim() !== '') roots.push(config.root.trim())
  }
  if (config.mode === 'file' && config.file.trim() !== '') files.push(config.file.trim())
  return { roots, files }
}

/** 统一的 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** 读请求体并解析 JSON；超过 64KB 或解析失败返回 null。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 65536) return null
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 同源校验：写请求的 Origin 必须与请求本身的 Host 一致。
 *
 * 没有这道闸，浏览器里任意页面都能跨站 POST 改写壁纸根目录（把它指向 C:\），
 * 再逐个 `/media` 读取本机文件。
 *
 * 判据是「Origin.host === Host 头」而不是「Origin 是不是 loopback」：后者会让
 * 经局域网 IP 打开的 dsh 写不进配置，而前者既挡住跨站、又不限制访问方式。
 * 浏览器对 POST 一律带 Origin，所以 Origin 缺失只可能来自非浏览器客户端；
 * 那种客户端本来就能直接读盘，不构成提权，故放行。
 */
function isSameOrigin(req) {
  const origin = req.headers.origin || ''
  if (origin === '') return true
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }
  return originHost === (req.headers.host || '')
}

/**
 * 媒体转发。
 *
 * 视频需要 Range 支持才能被浏览器流畅循环播放，所以对视频实现了单段 206 响应；
 * 图片一律整文件 200。
 */
async function serveMedia(req, res, rawPath, allow) {
  const requested = String(rawPath)
  if (requested === '' || classifyPath(requested) === null) {
    writeJson(res, 400, { ok: false, error: 'unsupported media type' })
    return
  }
  // realpath 归一后再判白名单：挡住指向库外的符号链接
  let real
  try {
    real = await realpath(requested)
  } catch {
    writeJson(res, 404, { ok: false, error: 'not found' })
    return
  }
  if (!isAllowedMedia(real, allow)) {
    writeJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }

  let info
  try {
    info = await stat(real)
  } catch {
    writeJson(res, 404, { ok: false, error: 'not found' })
    return
  }
  if (!info.isFile()) {
    writeJson(res, 404, { ok: false, error: 'not found' })
    return
  }

  const type = CONTENT_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream'
  const headers = {
    'content-type': type,
    'cache-control': 'private, max-age=' + MEDIA_CACHE_SECONDS,
    'accept-ranges': 'bytes',
  }

  const range = req.headers.range
  const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  if (match !== null) {
    const startRaw = match[1]
    const endRaw = match[2]
    let start = startRaw === '' ? NaN : Number(startRaw)
    let end = endRaw === '' ? NaN : Number(endRaw)
    if (Number.isNaN(start)) {
      // "bytes=-N"：末尾 N 字节
      const suffix = Number.isNaN(end) ? 0 : end
      start = Math.max(0, info.size - suffix)
      end = info.size - 1
    } else if (Number.isNaN(end)) {
      end = info.size - 1
    }
    if (start > end || start >= info.size) {
      res.writeHead(416, { 'content-range': 'bytes */' + info.size })
      res.end()
      return
    }
    end = Math.min(end, info.size - 1)
    res.writeHead(206, {
      ...headers,
      'content-range': 'bytes ' + start + '-' + end + '/' + info.size,
      'content-length': String(end - start + 1),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(real, { start, end })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }

  res.writeHead(200, { ...headers, 'content-length': String(info.size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(real)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const webServer = ctx.webServer
  if (webServer === undefined) return

  const file = configPath()
  /** 内存中的配置副本；写接口先改它再落盘，读接口只读它，避免每次请求都读盘。 */
  let config = { ...DEFAULT_CONFIG }
  let loaded = false

  async function load() {
    if (loaded) return
    loaded = true
    try {
      const raw = await readFile(file, 'utf8')
      config = normalizeConfig(JSON.parse(raw))
    } catch {
      // 文件不存在或损坏：保持默认值，插件静默可用
      config = { ...DEFAULT_CONFIG }
    }
  }

  async function save() {
    try {
      await writeFile(file, JSON.stringify(config, null, 2), 'utf8')
    } catch (error) {
      console.error('[dsh-wallpaper] 写入配置失败: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /** 组装给客户端的完整状态。 */
  async function buildState() {
    const scanned = await scanFor(config)
    return {
      ok: true,
      config: {
        mode: config.mode,
        root: config.root,
        file: config.file,
        url: config.url,
        opacity: config.opacity,
        blur: config.blur,
        dim: config.dim,
        fit: config.fit,
      },
      current: config.current,
      items: scanned.items,
      workshopRoot: scanned.workshopRoot,
      error: scanned.error,
    }
  }

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        await load()
        const url = new URL(req.url ?? '/', 'http://dsh.local')
        const route = url.pathname.slice(ROUTE_PREFIX.length) || '/state'
        const method = req.method ?? 'GET'

        // ── 媒体转发（GET/HEAD，浏览器 <img>/<video> 直接发起）──
        if (route === '/media') {
          if (method !== 'GET' && method !== 'HEAD') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          await serveMedia(req, res, url.searchParams.get('path') ?? '', allowListFor(config))
          return
        }

        // ── 状态读取 ──
        if (route === '/state' && method === 'GET') {
          writeJson(res, 200, await buildState())
          return
        }

        // ── 以下均为写接口，先过同源校验 ──
        if (method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!isSameOrigin(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const body = await readJsonBody(req)
        if (body === null) {
          writeJson(res, 400, { ok: false, error: 'invalid json body' })
          return
        }

        if (route === '/config') {
          const next = { ...config }
          if (body.mode !== undefined) next.mode = MODES.has(body.mode) ? body.mode : config.mode
          if (typeof body.root === 'string') next.root = body.root
          if (typeof body.file === 'string') next.file = body.file
          if (typeof body.url === 'string') next.url = body.url
          if (body.opacity !== undefined) next.opacity = clampNumber(body.opacity, 0, 1, config.opacity)
          if (body.blur !== undefined) next.blur = clampNumber(body.blur, 0, 40, config.blur)
          if (body.dim !== undefined) next.dim = clampNumber(body.dim, 0, 1, config.dim)
          if (body.fit !== undefined) next.fit = FITS.has(body.fit) ? body.fit : config.fit
          // 换了来源就作废当前选择，避免"选着 A 库的图、根目录已指向 B 库"的悬空状态
          const sourceChanged = next.mode !== config.mode || next.root !== config.root
            || next.file !== config.file || next.url !== config.url
          if (sourceChanged) next.current = null
          config = normalizeConfig(next)
          await save()
          writeJson(res, 200, await buildState())
          return
        }

        if (route === '/select') {
          const id = typeof body.id === 'string' ? body.id : ''
          const scanned = await scanFor(config)
          const picked = scanned.items.find((item) => item.id === id)
          if (picked === undefined) {
            writeJson(res, 404, { ok: false, error: '该壁纸已不在当前列表中，请重新扫描' })
            return
          }
          config = normalizeConfig({ ...config, current: picked })
          await save()
          writeJson(res, 200, await buildState())
          return
        }

        if (route === '/clear') {
          config = normalizeConfig({ ...config, current: null })
          await save()
          writeJson(res, 200, await buildState())
          return
        }

        writeJson(res, 404, { ok: false, error: 'unknown route' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-wallpaper: api route')

  console.error('[dsh-wallpaper] 主题管理已挂载（配置：' + file + '）')
}
