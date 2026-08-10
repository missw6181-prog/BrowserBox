import {
  existsSync,
  readdirSync,
  mkdirSync,
  createWriteStream,
  unlinkSync,
  createReadStream,
  cpSync,
  rmSync
} from 'fs'
import { ErrorCodes } from '../../shared/types'
import { join } from 'path'
import { get } from 'https'
import { is } from '@electron-toolkit/utils'
import { Extract } from 'unzipper'
import { configManager } from '../config/ConfigManager'
import { logger } from '../logger/Logger'

const CFT_STABLE_API =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
const CFT_MILESTONE_API =
  'https://googlechromelabs.github.io/chrome-for-testing/latest-versions-per-milestone-with-downloads.json'

/** 环境 browserVersion 使用此值表示本机 Google Chrome */
export const SYSTEM_BROWSER_ID = 'system'

interface CftDownload {
  platform: string
  url: string
}

interface CftChannel {
  version: string
  revision: string
  downloads: { chrome?: CftDownload[] }
}

export interface BrowserInstallInfo {
  id: string
  major: string
  version: string
  path: string
  source: 'cft' | 'system'
  label: string
}

export interface MilestoneInfo {
  milestone: string
  version: string
  url: string
  installed: boolean
}

/**
 * Manage Chrome for Testing under <dataDir>/Browser/<major>/
 * and optional system Google Chrome.
 */
export class BrowserManager {
  /** 安装包内置 CfT 目录（extraResources/bundled-browsers）。开发态不从工程目录灌入。 */
  getBundledBrowsersRoot(): string | null {
    // 安装包已默认不附带 CfT；开发态若对工程内巨型 chrome-win64 做 cpSync，
    // 在含中文的长路径下会触发 Electron 原生崩溃（0xC0000409 / basic_string）。
    if (is.dev) return null
    return join(process.resourcesPath, 'bundled-browsers')
  }

  /**
   * 把安装包自带的 Chrome for Testing 复制到数据目录（已存在则跳过）。
   * 在选择/初始化数据目录后调用。开发态与无内置资源时均为空操作。
   */
  seedBundledBrowsers(): string[] {
    if (!configManager.isReady()) return []
    const srcRoot = this.getBundledBrowsersRoot()
    if (!srcRoot || !existsSync(srcRoot)) {
      logger.info('browser', '无内置浏览器目录，跳过灌入', { srcRoot })
      return []
    }

    const dstRoot = configManager.resolvePath('Browser')
    mkdirSync(dstRoot, { recursive: true })
    const seeded: string[] = []

    const removed = new Set(configManager.get('settings').removedBrowserMajors || [])

    for (const name of readdirSync(srcRoot, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const major = name.name
      if (removed.has(major)) continue
      const src = join(srcRoot, major)
      const dst = join(dstRoot, major)
      if (this.findChromeExe(dst)) continue
      try {
        mkdirSync(dst, { recursive: true })
        cpSync(src, dst, { recursive: true })
        if (this.findChromeExe(dst)) {
          seeded.push(major)
          logger.info('browser', `已灌入内置 Chrome for Testing ${major}`)
        }
      } catch (err) {
        logger.warn('browser', `灌入内置浏览器失败 ${major}`, { err: String(err) })
      }
    }

    if (seeded.length) {
      const settings = configManager.get('settings')
      if (!settings.defaultBrowserVersion) {
        // 优先默认 Chrome for Testing 150
        const preferred = seeded.includes('150')
          ? '150'
          : [...seeded].sort((a, b) => Number(a) - Number(b))[0]
        configManager.updateSettings({ defaultBrowserVersion: preferred })
      }
    }
    // 已有灌入版本但未设默认时，同样优先 150
    this.ensureDefaultBrowser150()
    return seeded
  }

  /** 若已安装 150 且尚未设置默认，则设为 150 */
  ensureDefaultBrowser150(): void {
    if (!configManager.isReady()) return
    const settings = configManager.get('settings')
    if (settings.defaultBrowserVersion) return
    const root = configManager.resolvePath('Browser', '150')
    if (this.findChromeExe(root)) {
      configManager.updateSettings({ defaultBrowserVersion: '150' })
    }
  }

  detectSystemChrome(): { path: string; version: string } | null {
    const candidates = [
      join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'Google',
        'Chrome',
        'Application',
        'chrome.exe'
      ),
      join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ]

    for (const p of candidates) {
      if (p && existsSync(p)) {
        const version = this.readNearbyVersion(p) || '本机已安装'
        return { path: p, version }
      }
    }
    return null
  }

  private readNearbyVersion(chromeExe: string): string {
    try {
      const dir = join(chromeExe, '..')
      const entries = readdirSync(dir, { withFileTypes: true })
      const verDir = entries.find((e) => e.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(e.name))
      if (verDir) return verDir.name
    } catch {
      /* ignore */
    }
    return ''
  }

  /** 读取 chrome.exe 旁版本目录名，供指纹 UA 对齐 */
  getChromeVersion(chromeExe: string): string {
    return this.readNearbyVersion(chromeExe)
  }

  listInstalled(): BrowserInstallInfo[] {
    // 打开浏览器列表前确保内置版本已灌入数据目录
    try {
      this.seedBundledBrowsers()
    } catch {
      /* ignore */
    }
    try {
      this.ensureDefaultBrowser150()
    } catch {
      /* ignore */
    }

    const result: BrowserInstallInfo[] = []

    const system = this.detectSystemChrome()
    if (system) {
      result.push({
        id: SYSTEM_BROWSER_ID,
        major: SYSTEM_BROWSER_ID,
        version: system.version,
        path: system.path,
        source: 'system',
        label: `本机 Google Chrome (${system.version})`
      })
    }

    if (!configManager.isReady()) return result
    const root = configManager.resolvePath('Browser')
    if (!existsSync(root)) return result

    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const dir = join(root, d.name)
      const exe = this.findChromeExe(dir)
      if (!exe) continue
      result.push({
        id: d.name,
        major: d.name,
        version: d.name,
        path: exe,
        source: 'cft',
        label: `Chrome for Testing ${d.name}`
      })
    }

    return result
  }

  /**
   * Resolve chrome.exe for an environment browserVersion.
   * - "system" → 本机 Google Chrome
   * - "151" / "151.0.x" → 数据目录内 CfT
   * - 空 → 设置默认 → 任一 CfT → 本机 Chrome
   */
  resolveExecutable(versionOrMajor: string): string | null {
    const key = (versionOrMajor || '').trim()

    if (key === SYSTEM_BROWSER_ID || key === 'local') {
      return this.detectSystemChrome()?.path || null
    }

    if (configManager.isReady() && key) {
      const root = configManager.resolvePath('Browser')
      if (existsSync(root)) {
        const dirs = readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)

        const preferred = [key, ...dirs.filter((n) => n === key || n.startsWith(`${key}.`))]
        for (const name of preferred) {
          const dir = join(root, name)
          if (!existsSync(dir)) continue
          const exe = this.findChromeExe(dir)
          if (exe) return exe
        }
      }
    }

    if (configManager.isReady()) {
      const settings = configManager.get('settings')
      if (settings.defaultBrowserVersion && settings.defaultBrowserVersion !== key) {
        const fallback = this.resolveExecutable(settings.defaultBrowserVersion)
        if (fallback) return fallback
      }
      for (const item of this.listInstalled()) {
        if (item.source === 'cft') return item.path
      }
    }

    return this.detectSystemChrome()?.path || null
  }

  private findChromeExe(dir: string): string | null {
    const guesses = [
      join(dir, 'chrome.exe'),
      join(dir, 'chrome-win64', 'chrome.exe'),
      join(dir, 'chrome-win', 'chrome.exe')
    ]
    for (const g of guesses) {
      if (existsSync(g)) return g
    }
    try {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        if (name.isDirectory()) {
          const nested = join(dir, name.name, 'chrome.exe')
          if (existsSync(nested)) return nested
        }
      }
    } catch {
      /* ignore */
    }
    return null
  }

  async fetchLatestStable(): Promise<{ version: string; url: string; major: string }> {
    const json = await this.httpsGetJson(CFT_STABLE_API)
    const stable = json.channels.Stable as CftChannel
    const win = stable.downloads.chrome?.find((d) => d.platform === 'win64')
    if (!win) throw new Error('未找到 win64 Chrome for Testing 下载地址')
    const major = stable.version.split('.')[0]
    return { version: stable.version, url: win.url, major }
  }

  async listMilestones(): Promise<MilestoneInfo[]> {
    const json = await this.httpsGetJson(CFT_MILESTONE_API)
    const milestones = json.milestones || {}
    const installed = new Set(
      this.listInstalled()
        .filter((i) => i.source === 'cft')
        .map((i) => i.major)
    )

    const list: MilestoneInfo[] = []
    for (const [ms, info] of Object.entries(milestones) as Array<[string, any]>) {
      const win = info?.downloads?.chrome?.find((d: CftDownload) => d.platform === 'win64')
      if (!win?.url) continue
      list.push({
        milestone: String(ms),
        version: String(info.version || ms),
        url: win.url,
        installed: installed.has(String(ms))
      })
    }

    return list.sort((a, b) => Number(b.milestone) - Number(a.milestone))
  }

  async resolveDownload(target: string): Promise<{ version: string; url: string; major: string }> {
    const t = target.trim()
    if (!t || t === 'stable' || t === 'latest') {
      return this.fetchLatestStable()
    }

    // 纯主版本号，如 149
    if (/^\d{2,3}$/.test(t)) {
      const all = await this.listMilestones()
      const hit = all.find((m) => m.milestone === t)
      if (!hit) throw new Error(`未找到主版本 ${t} 的 Chrome for Testing`)
      return { version: hit.version, url: hit.url, major: hit.milestone }
    }

    // 完整版本号，尝试 milestone API 精确匹配，否则按主版本
    const major = t.split('.')[0]
    const all = await this.listMilestones()
    const exact = all.find((m) => m.version === t)
    if (exact) return { version: exact.version, url: exact.url, major: exact.milestone }
    const byMajor = all.find((m) => m.milestone === major)
    if (byMajor) return { version: byMajor.version, url: byMajor.url, major: byMajor.milestone }
    throw new Error(`未找到版本 ${t}`)
  }

  async installVersion(
    target: string,
    onProgress?: (msg: string) => void
  ): Promise<{ version: string; major: string; exe: string }> {
    const info = await this.resolveDownload(target)
    onProgress?.(`准备下载 Chrome ${info.version}`)
    const tempDir = configManager.resolvePath('Temp')
    mkdirSync(tempDir, { recursive: true })
    const zipPath = join(tempDir, `chrome-${info.version}.zip`)
    onProgress?.('下载中…')
    await this.downloadFile(info.url, zipPath, onProgress)
    const targetDir = configManager.resolvePath('Browser', info.major)
    mkdirSync(targetDir, { recursive: true })
    onProgress?.('解压中…')
    await this.unzip(zipPath, targetDir)
    try {
      unlinkSync(zipPath)
    } catch {
      /* ignore */
    }
    const exe = this.findChromeExe(targetDir)
    if (!exe) throw new Error('解压后未找到 chrome.exe')
    // 用户重新下载后，允许再次使用（清掉「已删除」标记）
    const removed = (configManager.get('settings').removedBrowserMajors || []).filter(
      (m) => m !== info.major
    )
    // 安装后默认优先使用 Chrome for Testing 150
    const has150 = !!this.findChromeExe(configManager.resolvePath('Browser', '150'))
    configManager.updateSettings({
      defaultBrowserVersion: has150 ? '150' : info.major,
      removedBrowserMajors: removed
    })
    logger.info('browser', `已安装 Chrome ${info.version} -> ${exe}`)
    onProgress?.('完成')
    return { version: info.version, major: info.major, exe }
  }

  /**
   * 删除数据目录中的 CfT 版本。
   * - 本机 Chrome（system）不可删
   * - 当前默认版本不可删
   * - 删除后记入 removedBrowserMajors，避免安装包内置版本被再次自动灌回
   */
  uninstall(id: string): void {
    const key = (id || '').trim()
    if (!key || key === SYSTEM_BROWSER_ID || key === 'local') {
      throw {
        code: ErrorCodes.CONFIG_INVALID,
        message: '本机 Google Chrome 不能通过本工具删除'
      }
    }
    if (!configManager.isReady()) {
      throw { code: ErrorCodes.DATA_DIR_NOT_SET, message: '数据目录未就绪' }
    }

    const settings = configManager.get('settings')
    if (settings.defaultBrowserVersion === key) {
      throw {
        code: ErrorCodes.CONFIG_INVALID,
        message: '当前默认浏览器不能删除，请先将其它版本设为默认'
      }
    }

    const dir = configManager.resolvePath('Browser', key)
    if (!existsSync(dir) || !this.findChromeExe(dir)) {
      throw {
        code: ErrorCodes.BROWSER_VERSION_NOT_FOUND,
        message: `未找到已安装的浏览器版本 ${key}`
      }
    }

    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      throw {
        code: ErrorCodes.CONFIG_WRITE_FAILED,
        message: `删除失败：${String(err)}`
      }
    }

    const removed = new Set(settings.removedBrowserMajors || [])
    removed.add(key)
    configManager.updateSettings({ removedBrowserMajors: [...removed] })
    logger.info('browser', `已删除 Chrome for Testing ${key}`, { dir })
  }

  async installLatestStable(
    onProgress?: (msg: string) => void
  ): Promise<{ version: string; major: string; exe: string }> {
    return this.installVersion('stable', onProgress)
  }

  private httpsGetJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.httpsGetJson(res.headers.location).then(resolve, reject)
          return
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`请求失败 HTTP ${res.statusCode}`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (e) {
            reject(e)
          }
        })
      }).on('error', reject)
    })
  }

  private downloadFile(url: string, dest: string, onProgress?: (msg: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = createWriteStream(dest)
      const doGet = (u: string): void => {
        get(u, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            file.close()
            doGet(res.headers.location)
            return
          }
          if (res.statusCode !== 200) {
            reject(new Error(`下载失败 HTTP ${res.statusCode}`))
            return
          }
          const total = Number(res.headers['content-length'] || 0)
          let got = 0
          res.on('data', (c: Buffer) => {
            got += c.length
            if (total > 0 && onProgress) {
              onProgress(`下载 ${((got / total) * 100).toFixed(0)}%`)
            }
          })
          res.pipe(file)
          file.on('finish', () => file.close(() => resolve()))
        }).on('error', (err) => {
          try {
            unlinkSync(dest)
          } catch {
            /* ignore */
          }
          reject(err)
        })
      }
      doGet(url)
    })
  }

  private unzip(zipPath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      createReadStream(zipPath)
        .pipe(Extract({ path: destDir }))
        .on('close', () => resolve())
        .on('error', reject)
    })
  }
}

export const browserManager = new BrowserManager()
