import {
  existsSync,
  readdirSync,
  rmSync,
  mkdirSync,
  createWriteStream,
  unlinkSync,
  createReadStream
} from 'fs'
import { join } from 'path'
import { get } from 'https'
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

export class BrowserManager {
  removeManagedBrowsers(): number {
    if (!configManager.isReady()) return 0
    const root = configManager.resolvePath('Browser')
    if (!existsSync(root)) return 0
    let removed = 0
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        rmSync(join(root, entry.name), { recursive: true, force: true })
        removed += 1
      } catch (err) {
        logger.warn('browser', `删除已下载浏览器失败 ${entry.name}`, { err: String(err) })
      }
    }
    if (removed) logger.info('browser', '已清理已下载浏览器目录', { removed })
    return removed
  }

  ensureSystemDefault(): void {
    if (!configManager.isReady()) return
    if (!this.detectSystemChrome()) return
    const settings = configManager.get('settings')
    if (settings.defaultBrowserVersion !== SYSTEM_BROWSER_ID) {
      configManager.updateSettings({ defaultBrowserVersion: SYSTEM_BROWSER_ID })
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

  listInstalled(): BrowserInstallInfo[] {
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
   * - 其它值也回退到本机 Chrome
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
          const exe = this.findChromeExe(join(root, name))
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
    }

    const system = this.detectSystemChrome()?.path || null
    if (system) return system
    return this.listInstalled().find((item) => item.source === 'cft')?.path || null
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
        if (!name.isDirectory()) continue
        const nested = join(dir, name.name, 'chrome.exe')
        if (existsSync(nested)) return nested
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
    this.ensureSystemDefault()
    logger.info('browser', `已安装 Chrome ${info.version} -> ${exe}`)
    onProgress?.('完成')
    return { version: info.version, major: info.major, exe }
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
