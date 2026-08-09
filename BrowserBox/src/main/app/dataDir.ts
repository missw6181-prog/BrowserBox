import { app } from 'electron'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { configManager } from '../config/ConfigManager'
import { browserManager } from '../browser/BrowserManager'
import { logger } from '../logger/Logger'

const BOOT_FILE = (): string => join(app.getPath('userData'), 'browserbox-boot.json')

export function readBoot(): { dataDir?: string } {
  try {
    const p = BOOT_FILE()
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf8')) as { dataDir?: string }
  } catch {
    return {}
  }
}

export function writeBoot(data: { dataDir: string }): void {
  const p = BOOT_FILE()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
}

/** 安装目录（开发态为项目根；打包态为 exe 所在目录） */
export function getInstallDir(): string {
  if (is.dev) return process.cwd()
  return dirname(app.getPath('exe'))
}

/** 默认数据目录：安装目录下的 Data */
export function getPreferredDataDir(): string {
  return join(getInstallDir(), 'Data')
}

function canUseAsDataDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.bb_write_${process.pid}.tmp`)
    writeFileSync(probe, '1')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * 启动时自动绑定数据目录：
 * 1) 已有 boot 记录 → 使用它
 * 2) 否则优先 {安装目录}/Data
 * 3) 若安装目录不可写（如 Program Files）→ 回退到 userData/Data
 */
export async function ensureDataDirReady(): Promise<{ ready: boolean; dataDir: string; auto: boolean }> {
  if (configManager.isReady()) {
    return { ready: true, dataDir: configManager.getDataDir(), auto: false }
  }

  const boot = readBoot()
  if (boot.dataDir) {
    try {
      await configManager.initialize(boot.dataDir)
      browserManager.seedBundledBrowsers()
      logger.info('app', `已加载数据目录 ${boot.dataDir}`)
      return { ready: true, dataDir: boot.dataDir, auto: false }
    } catch (err) {
      logger.warn('app', 'boot 数据目录不可用，将尝试默认路径', { err: String(err), dataDir: boot.dataDir })
    }
  }

  const preferred = getPreferredDataDir()
  if (canUseAsDataDir(preferred)) {
    await configManager.initialize(preferred)
    browserManager.seedBundledBrowsers()
    writeBoot({ dataDir: preferred })
    logger.info('app', `已自动使用安装目录旁数据目录 ${preferred}`)
    return { ready: true, dataDir: preferred, auto: true }
  }

  const fallback = join(app.getPath('userData'), 'Data')
  if (canUseAsDataDir(fallback)) {
    await configManager.initialize(fallback)
    browserManager.seedBundledBrowsers()
    writeBoot({ dataDir: fallback })
    logger.warn('app', `安装目录不可写，数据目录回退到 ${fallback}`, { preferred })
    return { ready: true, dataDir: fallback, auto: true }
  }

  return { ready: false, dataDir: preferred, auto: false }
}
