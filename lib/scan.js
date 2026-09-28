/**
 * dsh-wallpaper — 壁纸发现（扫描）层。
 *
 * 四种来源统一产出同一种 Wallpaper 记录，供 host 路由与 client 网格消费：
 *
 *   - `wallpaper-engine`：Wallpaper Engine 工坊根目录，逐项目读 `project.json`
 *   - `folder`：普通图片/视频文件夹
 *   - `file`：单个本地图片/视频文件
 *   - `url`：远端图片/视频链接（不落盘，直接交给浏览器）
 *
 * 记录里的 `path` 是**绝对磁盘路径**（url 模式除外），client 不能直接引用，
 * 必须经 `/api/dsh-wallpaper/media` 转发——该路由用 `isAllowedMedia()` 做白名单校验。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'

/** 可作为静态壁纸的扩展名。 */
export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])

/** 可作为动态壁纸的扩展名（浏览器原生可循环播放的容器）。 */
export const VIDEO_EXT = new Set(['.mp4', '.webm', '.m4v'])

/** Wallpaper Engine 在 Steam 工坊里的 appid（固定值，不是配置项）。 */
export const WE_APP_ID = '431960'

/**
 * 单个壁纸记录。
 * @typedef {object} Wallpaper
 * @property {string} id      稳定标识（同一来源下可复现）
 * @property {string} title   展示名
 * @property {'image'|'video'} kind
 * @property {string} path    绝对磁盘路径；url 来源时是原始 URL
 * @property {string} thumb   缩略图绝对路径（无独立缩略图时等于 path）
 * @property {'wallpaper-engine'|'folder'|'file'|'url'} source
 * @property {string} [weType]  Wallpaper Engine 项目类型（scene/video/web/application）
 * @property {string} [badge]   角标文案（如「视频」「场景预览」）
 */

/** 按扩展名判类型；不是受支持的媒体则返回 null。 */
export function classifyExt(ext) {
  const e = String(ext).toLowerCase()
  if (IMAGE_EXT.has(e)) return 'image'
  if (VIDEO_EXT.has(e)) return 'video'
  return null
}

/** 取文件扩展名并判类型（组合便捷函数）。 */
export function classifyPath(file) {
  return classifyExt(extname(String(file)))
}

/**
 * 路径是否落在某个允许的根目录内（或其就是某个被允许的单文件）。
 *
 * 用于 media 路由的越权防护：`/a/b` 不得匹配 `/a/bc`，所以补分隔符再比前缀。
 * 调用方须先对路径做过 `realpath`/`resolve` 归一，本函数只做纯字符串判定。
 *
 * @param {string} mediaPath  已归一化的绝对路径
 * @param {{ roots?: string[], files?: string[] }} allow
 */
export function isAllowedMedia(mediaPath, allow) {
  const target = resolve(String(mediaPath))
  const roots = Array.isArray(allow?.roots) ? allow.roots : []
  const files = Array.isArray(allow?.files) ? allow.files : []
  for (const f of files) {
    if (f !== '' && resolve(String(f)) === target) return true
  }
  for (const r of roots) {
    if (r === '') continue
    const root = resolve(String(r))
    if (target === root) return false // 根目录本身不是媒体文件
    if (target.startsWith(root.endsWith(sep) ? root : root + sep)) return true
  }
  return false
}

/** 目录条目是否可安全跳过（隐藏目录、Steam 元数据、node_modules）。 */
function isSkippable(name) {
  return name.startsWith('.') || name === 'node_modules'
}

/**
 * 扫描普通文件夹。
 *
 * 只扫一层：根目录下的媒体文件 + 一层子目录内的媒体文件。壁纸库动辄上千张，
 * 无界递归会让首次打开设置弹框卡住；一层深度已覆盖「按主题分子目录」的常见组织方式。
 *
 * @param {string} root 绝对路径
 * @param {{ maxEntries?: number }} [opts]
 * @returns {Promise<Wallpaper[]>}
 */
export async function scanFolder(root, opts = {}) {
  const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : 500
  const out = []
  const seen = new Set()

  const push = async (file, prefix) => {
    if (out.length >= maxEntries) return
    const kind = classifyPath(file)
    if (kind === null) return
    const key = resolve(file).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      id: 'folder:' + key,
      title: prefix === '' ? basename(file) : prefix + ' / ' + basename(file),
      kind,
      path: resolve(file),
      thumb: resolve(file),
      source: 'folder',
      ...(kind === 'video' ? { badge: '视频' } : {}),
    })
  }

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    if (out.length >= maxEntries) break
    if (isSkippable(entry.name)) continue
    const full = join(root, entry.name)
    if (entry.isFile()) {
      await push(full, '')
      continue
    }
    if (!entry.isDirectory()) continue
    // 一层子目录：用子目录名做标题前缀，便于在网格里分辨来源。
    let children
    try {
      children = await readdir(full, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (out.length >= maxEntries) break
      if (isSkippable(child.name) || !child.isFile()) continue
      await push(join(full, child.name), entry.name)
    }
  }
  return out
}

/**
 * 把用户填的根目录归一成真正的工坊内容目录。
 *
 * 用户可能填 Steam 根、`steamapps/workshop/content`、`.../content/431960` 或某个
 * 具体壁纸项目目录，这里逐级下探找到含 `project.json` 的那一层，避免"填错一级就空列表"。
 *
 * @param {string} root 用户配置的路径
 * @returns {Promise<string|null>} 工坊内容目录，找不到返回 null
 */
export async function resolveWorkshopRoot(root) {
  const candidates = [
    root,
    join(root, 'steamapps', 'workshop', 'content', WE_APP_ID),
    join(root, 'workshop', 'content', WE_APP_ID),
    join(root, 'content', WE_APP_ID),
    join(root, WE_APP_ID),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    if (existsSync(join(candidate, 'project.json'))) return candidate // 直接指向单个项目目录
    try {
      const entries = await readdir(candidate, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (existsSync(join(candidate, entry.name, 'project.json'))) return candidate
      }
    } catch {
      continue
    }
  }
  return null
}

/** 读并解析 project.json；损坏时返回 null（单个坏项目不该拖垮整次扫描）。 */
async function readProjectJson(dir) {
  try {
    const raw = await readFile(join(dir, 'project.json'), 'utf8')
    const data = JSON.parse(raw)
    return data !== null && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

/** 在项目目录里找一个存在的预览图（优先 project.json 的 preview 字段）。 */
async function findPreview(dir, project) {
  const named = typeof project?.preview === 'string' ? project.preview : ''
  const candidates = []
  if (named !== '') candidates.push(join(dir, named))
  for (const fallback of ['preview.jpg', 'preview.png', 'preview.gif', 'preview.jpeg', 'preview.webp']) {
    candidates.push(join(dir, fallback))
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    if (classifyPath(candidate) !== 'image') continue
    try {
      const info = await stat(candidate)
      if (info.isFile() && info.size > 0) return candidate
    } catch {
      continue
    }
  }
  return null
}

/**
 * 工坊 project.json 的 `type` 大小写并不统一（实测同一库里 `video` 与 `Video`
 * 并存），一律小写后再比较，否则一部分视频壁纸会被误判成静态图。
 */
function projectType(project) {
  return typeof project?.type === 'string' ? project.type.trim().toLowerCase() : ''
}

/**
 * 找 project.json 声明的视频文件（仅 video 类型有）。
 *
 * `file` 字段偶尔带路径分隔或指向不存在的文件，所以只信"确实存在且扩展名受支持"。
 */
async function findProjectVideo(dir, project) {
  if (projectType(project) !== 'video') return null
  const named = typeof project?.file === 'string' ? project.file.trim() : ''
  if (named === '') return null
  const candidate = join(dir, named)
  if (!existsSync(candidate)) return null
  if (classifyPath(candidate) !== 'video') return null
  try {
    const info = await stat(candidate)
    if (!info.isFile() || info.size === 0) return null
  } catch {
    return null
  }
  return candidate
}

/** 非视频项目的类型角标文案（视频项目由调用方给「视频」）。 */
const WE_TYPE_LABELS = {
  scene: '场景预览',
  web: '网页场景',
  application: '应用',
  text: '',
}

/**
 * 扫描 Wallpaper Engine 工坊目录。
 *
 * 每个壁纸项目按 `project.json` 的 `type` 决定能提供什么：
 *   - `video`  → 提供真实视频文件（可直接做动态壁纸）
 *   - 其它类型（scene/web/application）→ 只提供 preview 预览图（静态），
 *     因为 .pkg 场景包和 .html 网页场景浏览器无法直接播放
 *
 * @param {string} root 用户配置的 Wallpaper Engine 根目录
 * @param {{ maxEntries?: number }} [opts]
 * @returns {Promise<{ root: string|null, items: Wallpaper[] }>}
 */
export async function scanWallpaperEngine(root, opts = {}) {
  const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : 500
  const workshopRoot = await resolveWorkshopRoot(root)
  if (workshopRoot === null) return { root: null, items: [] }

  // 用户可能直接指着某个项目目录：这时把它自己当成唯一项目处理。
  if (existsSync(join(workshopRoot, 'project.json'))) {
    const single = await projectToWallpaper(workshopRoot)
    return { root: workshopRoot, items: single === null ? [] : [single] }
  }

  let entries
  try {
    entries = await readdir(workshopRoot, { withFileTypes: true })
  } catch {
    return { root: workshopRoot, items: [] }
  }

  const items = []
  for (const entry of entries) {
    if (items.length >= maxEntries) break
    if (!entry.isDirectory() || isSkippable(entry.name)) continue
    const item = await projectToWallpaper(join(workshopRoot, entry.name))
    if (item !== null) items.push(item)
  }
  items.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  return { root: workshopRoot, items }
}

/** 把单个工坊项目目录转成一条壁纸记录；无可用素材时返回 null。 */
async function projectToWallpaper(dir) {
  const project = await readProjectJson(dir)
  if (project === null) return null
  const title = typeof project.title === 'string' && project.title.trim() !== ''
    ? project.title.trim()
    : basename(dir)

  const preview = await findPreview(dir, project)
  const video = await findProjectVideo(dir, project)
  const weType = projectType(project)
  const key = resolve(dir).toLowerCase()

  // 视频项目优先给真视频；没有视频文件时退回预览图，保证列表不出现空条目。
  if (video !== null) {
    return {
      id: 'we:' + key,
      title,
      kind: 'video',
      path: video,
      thumb: preview !== null ? preview : video,
      source: 'wallpaper-engine',
      weType,
      badge: '视频',
    }
  }
  if (preview !== null) {
    const label = WE_TYPE_LABELS[weType] ?? ''
    return {
      id: 'we:' + key,
      title,
      kind: 'image',
      path: preview,
      thumb: preview,
      source: 'wallpaper-engine',
      weType,
      ...(label === '' ? {} : { badge: label }),
    }
  }
  return null
}

/**
 * 归一化 URL 来源：补协议、判类型。
 *
 * @param {string} raw 用户填的链接
 * @returns {Wallpaper|null}
 */
export function urlToWallpaper(raw) {
  const trimmed = String(raw).trim()
  if (trimmed === '') return null
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed
  let parsed
  try {
    parsed = new URL(withProto)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  // 从 pathname 判类型；判不出时按图片处理（很多图床链接没有扩展名）。
  const kind = classifyPath(parsed.pathname) ?? 'image'
  let title = basename(parsed.pathname)
  if (title === '' || title === '/') title = parsed.hostname
  return {
    id: 'url:' + parsed.href,
    title,
    kind,
    path: parsed.href,
    thumb: parsed.href,
    source: 'url',
    ...(kind === 'video' ? { badge: '视频' } : {}),
  }
}

/**
 * 单文件来源：校验存在性与类型。
 *
 * @param {string} raw 绝对路径
 * @returns {Promise<Wallpaper|null>}
 */
export async function fileToWallpaper(raw) {
  const file = String(raw).trim()
  if (file === '') return null
  const kind = classifyPath(file)
  if (kind === null) return null
  try {
    const info = await stat(file)
    if (!info.isFile()) return null
  } catch {
    return null
  }
  const abs = resolve(file)
  return {
    id: 'file:' + abs.toLowerCase(),
    title: basename(abs),
    kind,
    path: abs,
    thumb: abs,
    source: 'file',
    ...(kind === 'video' ? { badge: '视频' } : {}),
  }
}
